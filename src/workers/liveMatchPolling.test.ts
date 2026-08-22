import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Match } from "../domain";
import { buildGameweek, buildMatch } from "../testing/fixtures";

/**
 * Tests for the live-polling tick's reconciliation pass (docs/stuck-live-match-reconciliation-plan.md).
 *
 * The defect these pin: `GET /fixtures?league=39&live=all` returns only fixtures currently in
 * play, so the final whistle *removes* a fixture from that list instead of reporting it as FT.
 * A tick that acts solely on what the live list returns therefore can never observe
 * IN_PROGRESS -> COMPLETED, and the fixture's whole scoring pipeline stalls until the twice-daily
 * discovery pass heals it. Reconciliation asks about the fixtures that went missing, by id.
 *
 * importMatchData runs for real here (only the repositories are mocked), so what a test asserts
 * about newlyCompletedMatchIds is the genuine transition logic, not a stand-in for it.
 */
const mocks = vi.hoisted(() => ({
  getOrCreatePollState: vi.fn(),
  updatePollState: vi.fn(),
  findPotentiallyLiveMatches: vi.fn(),
  findEarliestUpcomingKickoff: vi.fn(),
  findMatchByExternalId: vi.fn(),
  upsertMatch: vi.fn(),
  upsertGameweekByNumber: vi.fn(),
  findPlayerByExternalId: vi.fn(),
  insertManyPlayerMatchStats: vi.fn(),
  insertManyMatchGoalEvents: vi.fn(),
  scheduleConfirmationPass: vi.fn(),
  countOwedConfirmationPasses: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  providerPollStateRepository: { getOrCreate: mocks.getOrCreatePollState, update: mocks.updatePollState },
  matchesRepository: {
    findPotentiallyLive: mocks.findPotentiallyLiveMatches,
    findEarliestUpcomingKickoff: mocks.findEarliestUpcomingKickoff,
    findByExternalId: mocks.findMatchByExternalId,
    upsert: mocks.upsertMatch,
  },
  gameweeksRepository: { upsertByNumber: mocks.upsertGameweekByNumber },
  playersRepository: { findByExternalId: mocks.findPlayerByExternalId },
  playerMatchStatsRepository: { insertMany: mocks.insertManyPlayerMatchStats },
  matchGoalEventsRepository: { insertMany: mocks.insertManyMatchGoalEvents },
  pendingConfirmationPassesRepository: {
    schedule: mocks.scheduleConfirmationPass,
    countOwed: mocks.countOwedConfirmationPasses,
  },
}));

import { ApiFootballProvider, type ApiFootballEnvelope } from "./apiFootballProvider";
import { StubFootballDataProvider, type ProviderFixture, type QuotaStatus } from "./footballDataProvider";
import { runLiveMatchPollingTick } from "./liveMatchPolling";

const POLL_STATE_ID = "poll-state-singleton";
/** Roughly the moment of the production incident: four minutes after the Arsenal v Coventry
 * final whistle, when the fixture had already left the live list. */
const POLL_TICK_NOW = new Date("2026-08-21T20:56:00Z");
const MINUTE_MS = 60 * 1000;
const MIN_POLL_INTERVAL_MS = 5 * MINUTE_MS;
const IDLE_POLL_INTERVAL_CAP_MS = 30 * MINUTE_MS;

function minutesBeforeTick(minutes: number): Date {
  return new Date(POLL_TICK_NOW.getTime() - minutes * MINUTE_MS);
}

function providerFixture(externalId: string, statusShortCode: string, overrides: Partial<ProviderFixture> = {}): ProviderFixture {
  return {
    externalId,
    roundLabel: "Regular Season - 1",
    homeClub: "Arsenal",
    awayClub: "Coventry",
    kickoffAt: minutesBeforeTick(116),
    statusShortCode,
    finalHomeScore: null,
    finalAwayScore: null,
    ...overrides,
  };
}

/**
 * A provider whose two fixture endpoints are scripted per test and whose calls are recorded. The
 * calls it does *not* receive matter as much as the ones it does: a reconciliation lookup costs
 * quota, so several cases assert silence on the common path.
 */
class ScriptedLivePollProvider extends StubFootballDataProvider {
  liveListRequestCount = 0;
  readonly reconciliationRequests: string[][] = [];
  reconciliationLookupError: Error | null = null;

  constructor(
    private readonly liveListFixtures: ProviderFixture[] = [],
    private readonly reconciledFixturesByExternalId: Record<string, ProviderFixture> = {},
  ) {
    super();
  }

  override async fetchLiveFixtures(): Promise<ProviderFixture[]> {
    this.liveListRequestCount += 1;
    return this.liveListFixtures;
  }

  override async fetchFixturesByExternalIds(externalFixtureIds: string[]): Promise<ProviderFixture[]> {
    this.reconciliationRequests.push(externalFixtureIds);
    if (this.reconciliationLookupError) throw this.reconciliationLookupError;
    return externalFixtureIds.flatMap((externalId) => this.reconciledFixturesByExternalId[externalId] ?? []);
  }

  /** The production plan's daily budget, so pacing assertions read against the real constraint. */
  override async fetchQuotaStatus(): Promise<QuotaStatus> {
    return { requestsUsedToday: 0, requestsLimitPerDay: 7500 };
  }
}

/** Points both the "what might be live" query and importMatchData's externalId lookup at the same
 * stored rows, the way the two repository reads see one database. */
function givenStoredMatches(storedMatches: Match[]): void {
  mocks.findPotentiallyLiveMatches.mockResolvedValue(storedMatches);
  mocks.findMatchByExternalId.mockImplementation(
    async (externalId: string) => storedMatches.find((match) => match.externalId === externalId) ?? null,
  );
}

/** How long the tick scheduled until the next poll. */
function scheduledNextPollDelayMs(): number {
  const lastUpdate = mocks.updatePollState.mock.calls.at(-1) as [string, { nextLivePollDueAt: Date }] | undefined;
  if (!lastUpdate) throw new Error("the tick scheduled no next poll");
  return lastUpdate[1].nextLivePollDueAt.getTime() - POLL_TICK_NOW.getTime();
}

function upsertedMatchStatusByExternalId(): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const [match] of mocks.upsertMatch.mock.calls as [Match][]) {
    statuses[match.externalId!] = match.status;
  }
  return statuses;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(POLL_TICK_NOW);
  mocks.getOrCreatePollState.mockResolvedValue({ id: POLL_STATE_ID, nextLivePollDueAt: null });
  mocks.findEarliestUpcomingKickoff.mockResolvedValue(null);
  mocks.upsertGameweekByNumber.mockImplementation(async (gameweekNumber: number) =>
    buildGameweek({ id: `gw-${gameweekNumber}`, number: gameweekNumber }),
  );
  mocks.findPlayerByExternalId.mockResolvedValue(null);
  mocks.countOwedConfirmationPasses.mockResolvedValue(0);
  givenStoredMatches([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runLiveMatchPollingTick — reconciling matches missing from the live list", () => {
  it("resolves a match that left the live list at full time, completing it on the very next tick", async () => {
    // The production incident exactly: fixture 1557367 is IN_PROGRESS on our side, the whistle has
    // gone, and `live=all` no longer mentions it.
    givenStoredMatches([
      buildMatch({ id: "match-arsenal-coventry", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(116) }),
    ]);
    const provider = new ScriptedLivePollProvider([], {
      "1557367": providerFixture("1557367", "FT", { finalHomeScore: 3, finalAwayScore: 0 }),
    });

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.reconciliationRequests).toEqual([["1557367"]]);
    expect(result.newlyCompletedMatchIds).toEqual(["match-arsenal-coventry"]);
    expect(upsertedMatchStatusByExternalId()).toEqual({ "1557367": "COMPLETED" });
    expect(mocks.scheduleConfirmationPass).toHaveBeenCalledTimes(1);
  });

  it("asks only about the match the live list left out, not the one it reported", async () => {
    givenStoredMatches([
      buildMatch({ id: "match-finished", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(116) }),
      buildMatch({ id: "match-still-playing", externalId: "1557368", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
    ]);
    const provider = new ScriptedLivePollProvider([providerFixture("1557368", "2H")], {
      "1557367": providerFixture("1557367", "FT", { finalHomeScore: 3, finalAwayScore: 0 }),
    });

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.reconciliationRequests).toEqual([["1557367"]]);
    expect(result.newlyCompletedMatchIds).toEqual(["match-finished"]);
  });

  it("spends no reconciliation call at all when the live list accounts for every match", async () => {
    // The common path — a matchday's fixtures are in play and reported as such. Reconciliation
    // costs quota, so this regression guard is about what the tick must NOT do.
    givenStoredMatches([
      buildMatch({ id: "match-one", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
      buildMatch({ id: "match-two", externalId: "1557368", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
    ]);
    const provider = new ScriptedLivePollProvider([providerFixture("1557367", "1H"), providerFixture("1557368", "2H")]);

    await runLiveMatchPollingTick(provider);

    expect(provider.liveListRequestCount).toBe(1);
    expect(provider.reconciliationRequests).toEqual([]);
  });

  it("leaves a just-kicked-off scheduled match alone while it is inside the grace period", async () => {
    givenStoredMatches([
      buildMatch({ id: "match-kicking-off", externalId: "1557367", status: "SCHEDULED", kickoffAt: minutesBeforeTick(2) }),
    ]);
    const provider = new ScriptedLivePollProvider([]);

    await runLiveMatchPollingTick(provider);

    expect(provider.reconciliationRequests).toEqual([]);
  });

  it("reconciles a scheduled match still missing well after its kickoff time", async () => {
    givenStoredMatches([
      buildMatch({ id: "match-never-seen-live", externalId: "1557367", status: "SCHEDULED", kickoffAt: minutesBeforeTick(20) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "1H") });

    await runLiveMatchPollingTick(provider);

    expect(provider.reconciliationRequests).toEqual([["1557367"]]);
    expect(upsertedMatchStatusByExternalId()).toEqual({ "1557367": "IN_PROGRESS" });
  });

  it("skips matches with no externalId instead of asking the provider about nothing", async () => {
    // matches.external_id is nullable and seeded/mock rows leave it null — there is no id to ask
    // about, so such a row must be passed over rather than crashing the tick.
    givenStoredMatches([buildMatch({ id: "match-seeded", externalId: null, status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(60) })]);
    const provider = new ScriptedLivePollProvider([]);

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.reconciliationRequests).toEqual([]);
    expect(result.newlyCompletedMatchIds).toEqual([]);
    expect(mocks.upsertMatch).not.toHaveBeenCalled();
  });

  it("hands every missing id to the provider in one call, leaving batching to the provider", async () => {
    // 21 stuck fixtures is more than one request can carry; splitting them into batches of 20 is
    // ApiFootballProvider's job (pinned in apiFootballProvider.test.ts and end to end below), so
    // what the tick owes is completeness — no id silently dropped.
    const stuckMatches = Array.from({ length: 21 }, (_, index) =>
      buildMatch({
        id: `match-${index}`,
        externalId: String(1557000 + index),
        status: "IN_PROGRESS",
        kickoffAt: minutesBeforeTick(116),
      }),
    );
    givenStoredMatches(stuckMatches);
    const provider = new ScriptedLivePollProvider([]);

    await runLiveMatchPollingTick(provider);

    expect(provider.reconciliationRequests).toHaveLength(1);
    expect(provider.reconciliationRequests[0]).toHaveLength(21);
  });
});

describe("runLiveMatchPollingTick — what a reconciled fixture resolves to", () => {
  it("voids an abandoned match and reports it as disrupted, never as completed", async () => {
    givenStoredMatches([
      buildMatch({ id: "match-abandoned", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(60) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "ABD") });

    const result = await runLiveMatchPollingTick(provider);

    expect(upsertedMatchStatusByExternalId()).toEqual({ "1557367": "VOIDED" });
    expect(result.newlyDisruptedMatchIds).toEqual(["match-abandoned"]);
    expect(result.newlyCompletedMatchIds).toEqual([]);
  });

  it("postpones a match the provider now reports as PST and reports it as disrupted", async () => {
    givenStoredMatches([
      buildMatch({ id: "match-postponed", externalId: "1557367", status: "SCHEDULED", kickoffAt: minutesBeforeTick(45) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "PST") });

    const result = await runLiveMatchPollingTick(provider);

    expect(upsertedMatchStatusByExternalId()).toEqual({ "1557367": "POSTPONED" });
    expect(result.newlyDisruptedMatchIds).toEqual(["match-postponed"]);
    expect(result.newlyCompletedMatchIds).toEqual([]);
  });

  it("keeps a match the provider still reports as in play live, and keeps polling at the live cadence", async () => {
    // A one-poll provider blip, not a final whistle. Pacing must come off the merged set:
    // counting only the live list would drop this match to the 30-minute idle interval for the
    // rest of the match, having "resolved" it as no longer live.
    givenStoredMatches([
      buildMatch({ id: "match-blipped", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "2H") });

    const result = await runLiveMatchPollingTick(provider);

    expect(upsertedMatchStatusByExternalId()).toEqual({ "1557367": "IN_PROGRESS" });
    expect(result.newlyCompletedMatchIds).toEqual([]);
    expect(scheduledNextPollDelayMs()).toBe(MIN_POLL_INTERVAL_MS);
    expect(scheduledNextPollDelayMs()).not.toBe(IDLE_POLL_INTERVAL_CAP_MS);
  });

  it("treats a suspended match as still live for pacing, since it is expected to resume", async () => {
    givenStoredMatches([
      buildMatch({ id: "match-suspended", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "SUSP") });

    await runLiveMatchPollingTick(provider);

    expect(upsertedMatchStatusByExternalId()).toEqual({ "1557367": "INTERRUPTED" });
    expect(scheduledNextPollDelayMs()).toBe(MIN_POLL_INTERVAL_MS);
  });

  it("drops to the idle cadence once the merged set holds nothing still in play", async () => {
    givenStoredMatches([
      buildMatch({ id: "match-finished", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(116) }),
    ]);
    const provider = new ScriptedLivePollProvider([], {
      "1557367": providerFixture("1557367", "FT", { finalHomeScore: 3, finalAwayScore: 0 }),
    });

    await runLiveMatchPollingTick(provider);

    expect(scheduledNextPollDelayMs()).toBe(IDLE_POLL_INTERVAL_CAP_MS);
  });
});

describe("runLiveMatchPollingTick — degrading safely", () => {
  it("still imports the live list and still schedules the next poll when the reconciliation call fails", async () => {
    givenStoredMatches([
      buildMatch({ id: "match-missing", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(116) }),
      buildMatch({ id: "match-still-playing", externalId: "1557368", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
    ]);
    const provider = new ScriptedLivePollProvider([providerFixture("1557368", "2H")]);
    provider.reconciliationLookupError = new Error("API-Football request failed: 503 Service Unavailable (fixtures)");

    const result = await runLiveMatchPollingTick(provider);

    // The live-list fixture imports as normal; the unresolved one is simply left for the next tick.
    expect(upsertedMatchStatusByExternalId()).toEqual({ "1557368": "IN_PROGRESS" });
    expect(result.newlyCompletedMatchIds).toEqual([]);
    // A failed repair must never leave nextLivePollDueAt un-advanced — that would hot-loop.
    expect(scheduledNextPollDelayMs()).toBeGreaterThan(0);
  });

  it("makes no provider call whatsoever while the next poll is not yet due", async () => {
    mocks.getOrCreatePollState.mockResolvedValue({
      id: POLL_STATE_ID,
      nextLivePollDueAt: new Date(POLL_TICK_NOW.getTime() + MINUTE_MS),
    });
    givenStoredMatches([
      buildMatch({ id: "match-missing", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(116) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "FT") });

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.liveListRequestCount).toBe(0);
    expect(provider.reconciliationRequests).toEqual([]);
    expect(mocks.findPotentiallyLiveMatches).not.toHaveBeenCalled();
    expect(mocks.updatePollState).not.toHaveBeenCalled();
    expect(result).toEqual({ newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [] });
  });
});

describe("runLiveMatchPollingTick — not completing the same match twice", () => {
  /* awardGameweekFreeTransfers increments every team by 2 unconditionally, so a duplicate entry
   * in newlyCompletedMatchIds silently gifts every manager two extra transfers. Reconciliation
   * adds a second route into that list, which makes these correctness tests, not tidiness ones. */

  it("stops polling a match once it is COMPLETED — the second tick asks the provider nothing", async () => {
    const stuckMatch = buildMatch({
      id: "match-arsenal-coventry",
      externalId: "1557367",
      status: "IN_PROGRESS",
      kickoffAt: minutesBeforeTick(116),
    });
    givenStoredMatches([stuckMatch]);
    const firstTickProvider = new ScriptedLivePollProvider([], {
      "1557367": providerFixture("1557367", "FT", { finalHomeScore: 3, finalAwayScore: 0 }),
    });

    const firstResult = await runLiveMatchPollingTick(firstTickProvider);
    expect(firstResult.newlyCompletedMatchIds).toEqual(["match-arsenal-coventry"]);

    // Second tick: the row is COMPLETED, so findPotentiallyLive no longer returns it at all.
    givenStoredMatches([]);
    mocks.getOrCreatePollState.mockResolvedValue({ id: POLL_STATE_ID, nextLivePollDueAt: null });
    const secondTickProvider = new ScriptedLivePollProvider([], {
      "1557367": providerFixture("1557367", "FT", { finalHomeScore: 3, finalAwayScore: 0 }),
    });

    const secondResult = await runLiveMatchPollingTick(secondTickProvider);

    expect(secondTickProvider.liveListRequestCount).toBe(0);
    expect(secondTickProvider.reconciliationRequests).toEqual([]);
    expect(secondResult.newlyCompletedMatchIds).toEqual([]);
  });

  it("reports no new completion when a reconciled fixture is already COMPLETED on our side", async () => {
    // Defence in depth for the route above: even if a stale row keeps a finished fixture in the
    // reconciliation set, only a genuine transition may reach newlyCompletedMatchIds.
    givenStoredMatches([
      buildMatch({ id: "match-arsenal-coventry", externalId: "1557367", status: "COMPLETED", kickoffAt: minutesBeforeTick(116) }),
    ]);
    mocks.findPotentiallyLiveMatches.mockResolvedValue([
      buildMatch({ id: "match-arsenal-coventry", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(116) }),
    ]);
    const provider = new ScriptedLivePollProvider([], {
      "1557367": providerFixture("1557367", "FT", { finalHomeScore: 3, finalAwayScore: 0 }),
    });

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.reconciliationRequests).toEqual([["1557367"]]);
    expect(result.newlyCompletedMatchIds).toEqual([]);
    expect(mocks.scheduleConfirmationPass).not.toHaveBeenCalled();
  });
});

/**
 * Replays real-shaped API-Football envelopes (verified against the live API on 2026-08-22) through
 * ApiFootballProvider's own parsing and batching, so the reconciliation path is exercised end to
 * end — tick, provider, import — with no network and no quota spent. The recorded-envelope variant
 * (`fixtures__ids=<id>.json` under __fixtures__, replayed by OfflineFootballDataProvider) would
 * cost a live call to record, so it is deliberately not the form used here.
 */
class InMemoryApiFootballProvider extends ApiFootballProvider {
  readonly requestedFixtureIdParameters: string[] = [];

  constructor(private readonly rawFixtureEntriesByExternalId: Record<string, unknown>) {
    super("https://in-memory.invalid", "test-no-key", 2026);
    // Fixture stat coverage off: this exercises the fixture-status path, and leaving it on would
    // require players/events envelopes that say nothing about reconciliation.
    this.setCurrentSeason(2026, { fixturePlayerStats: false, injuries: false });
  }

  protected override async request<T>(path: string, params: Record<string, string | number> = {}): Promise<ApiFootballEnvelope<T>> {
    if (path !== "fixtures") throw new Error(`Unexpected request: ${path}`);
    if (params.live === "all") return { response: [] as T, errors: [] };
    const requestedIds = String(params.ids);
    this.requestedFixtureIdParameters.push(requestedIds);
    const matchedEntries = requestedIds
      .split("-")
      .flatMap((externalId) => this.rawFixtureEntriesByExternalId[externalId] ?? []);
    return { response: matchedEntries as T, errors: [] };
  }
}

function rawFinishedFixtureEntry(externalFixtureId: string): unknown {
  return {
    fixture: {
      id: Number(externalFixtureId),
      date: "2026-08-21T19:00:00+00:00",
      status: { short: "FT", long: "Match Finished", elapsed: 90 },
    },
    league: { round: "Regular Season - 1" },
    teams: { home: { name: "Arsenal" }, away: { name: "Coventry" } },
    goals: { home: 3, away: 0 },
  };
}

describe("runLiveMatchPollingTick — through the real provider, on real envelope shapes", () => {
  it("completes a stuck match end to end without a single line of test-only parsing", async () => {
    givenStoredMatches([
      buildMatch({ id: "match-arsenal-coventry", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(116) }),
    ]);
    const provider = new InMemoryApiFootballProvider({ "1557367": rawFinishedFixtureEntry("1557367") });

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.requestedFixtureIdParameters).toEqual(["1557367"]);
    expect(result.newlyCompletedMatchIds).toEqual(["match-arsenal-coventry"]);
    const [upsertedMatch] = mocks.upsertMatch.mock.calls[0]! as [Match];
    expect(upsertedMatch.status).toBe("COMPLETED");
    expect(upsertedMatch.finalHomeScore).toBe(3);
    expect(upsertedMatch.finalAwayScore).toBe(0);
  });

  it("splits 21 stuck matches into two targeted requests of 20 and 1", async () => {
    const stuckExternalIds = Array.from({ length: 21 }, (_, index) => String(1557000 + index));
    givenStoredMatches(
      stuckExternalIds.map((externalId, index) =>
        buildMatch({ id: `match-${index}`, externalId, status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(116) }),
      ),
    );
    const provider = new InMemoryApiFootballProvider(
      Object.fromEntries(stuckExternalIds.map((externalId) => [externalId, rawFinishedFixtureEntry(externalId)])),
    );

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.requestedFixtureIdParameters).toHaveLength(2);
    expect(provider.requestedFixtureIdParameters[0]!.split("-")).toHaveLength(20);
    expect(provider.requestedFixtureIdParameters[1]).toBe("1557020");
    expect(result.newlyCompletedMatchIds).toHaveLength(21);
  });
});
