import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MATCH_STATUSES_UNDER_WAY_BUT_NOT_YET_RESOLVED, type Match } from "../domain";
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

function hoursBeforeTick(hours: number): Date {
  return minutesBeforeTick(hours * 60);
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

  /** Defaults to the production plan's daily budget, so pacing assertions read against the real
   * constraint. Overridable per test: on a roomy quota the round arithmetic always floors to
   * MIN_POLL_INTERVAL_MS, which hides whether it is computed at all. */
  quotaStatus: QuotaStatus = { requestsUsedToday: 0, requestsLimitPerDay: 7500 };

  override async fetchQuotaStatus(): Promise<QuotaStatus> {
    return this.quotaStatus;
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

/**
 * Feeds "the database" instead of hand-feeding the tick an answer: applies findPotentiallyLive's
 * *real* predicate — a non-terminal status, and for the SCHEDULED/DELAYED arm a kickoff already
 * past — to a set of stored rows, and serves the survivors.
 *
 * It carries no abandonment-window bound because the repository carries none, and that is exactly
 * the point of the tests that use it. The window is enforced only in the worker, so a stale row must
 * genuinely survive the query and reach runLiveMatchPollingTick in order to be reported before it is
 * dropped. Filtering it upstream would leave a permanently stuck fixture with no signal at all.
 */
function givenDatabaseMatches(storedMatches: Match[]): void {
  const rowsFindPotentiallyLiveWouldReturn = storedMatches.filter((match) =>
    MATCH_STATUSES_UNDER_WAY_BUT_NOT_YET_RESOLVED.includes(match.status)
      ? true
      : (match.status === "SCHEDULED" || match.status === "DELAYED") && match.kickoffAt <= POLL_TICK_NOW,
  );
  mocks.findPotentiallyLiveMatches.mockResolvedValue(rowsFindPotentiallyLiveWouldReturn);
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

describe("runLiveMatchPollingTick — an interrupted match is not a dead end", () => {
  /* INTERRUPTED (the provider's SUSP/INT) is not terminal: the match either resumes or is
   * abandoned. Until the poller is told which, the row blocks its gameweek's completion —
   * INTERRUPTED is one of MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION — so an INTERRUPTED row
   * the poller cannot re-examine reproduces the very stall
   * docs/stuck-live-match-reconciliation-plan.md exists to remove. These pin that it is chased
   * exactly like an IN_PROGRESS one. */

  it("asks the provider about an interrupted match missing from the live list, with no grace period", async () => {
    // Kickoff is only 5 minutes ago: a SCHEDULED row this fresh would be inside
    // MISSING_KICKOFF_GRACE_MS and left alone, so the call proves INTERRUPTED is reconciled
    // unconditionally rather than merely surviving the grace check.
    givenStoredMatches([
      buildMatch({ id: "match-suspended", externalId: "1557367", status: "INTERRUPTED", kickoffAt: minutesBeforeTick(5) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "SUSP") });

    await runLiveMatchPollingTick(provider);

    expect(provider.reconciliationRequests).toEqual([["1557367"]]);
    expect(upsertedMatchStatusByExternalId()).toEqual({ "1557367": "INTERRUPTED" });
  });

  it("voids an interrupted match the provider now reports as abandoned, releasing its gameweek", async () => {
    givenStoredMatches([
      buildMatch({ id: "match-suspended", externalId: "1557367", status: "INTERRUPTED", kickoffAt: minutesBeforeTick(70) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "ABD") });

    const result = await runLiveMatchPollingTick(provider);

    expect(upsertedMatchStatusByExternalId()).toEqual({ "1557367": "VOIDED" });
    expect(result.newlyDisruptedMatchIds).toEqual(["match-suspended"]);
    expect(result.newlyCompletedMatchIds).toEqual([]);
  });

  it("returns a resumed match to in-progress and stays on the live cadence", async () => {
    givenStoredMatches([
      buildMatch({ id: "match-suspended", externalId: "1557367", status: "INTERRUPTED", kickoffAt: minutesBeforeTick(70) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "2H") });

    const result = await runLiveMatchPollingTick(provider);

    expect(upsertedMatchStatusByExternalId()).toEqual({ "1557367": "IN_PROGRESS" });
    expect(result.newlyCompletedMatchIds).toEqual([]);
    expect(scheduledNextPollDelayMs()).toBe(MIN_POLL_INTERVAL_MS);
  });
});

describe("runLiveMatchPollingTick — letting go of a match long past its kickoff", () => {
  /* The tick is armed by findPotentiallyLive returning anything at all. Before
   * MATCH_POLLING_ABANDONMENT_WINDOW_MS existed that query had no lower time bound, so one stale
   * non-terminal row — a seed, a previous season, a fixture the provider quietly dropped,
   * rescheduleGameweekIntoFuture drift — armed it forever: a fetchLiveFixtures every idle interval
   * (~48/day), plus a reconciliation lookup every tick once the row cleared the 15-minute grace,
   * right through the off-season. And if the provider no longer recognises the id, reconciliation
   * returns nothing, the row is never cleared, and the spend never stops. These pin the poller
   * letting go and handing the row to the twice-daily discovery pass, which — unlike `live=all` —
   * carries terminal statuses and can actually resolve it. */

  it("makes no provider call at all for a scheduled match three days past its kickoff", async () => {
    givenDatabaseMatches([
      buildMatch({ id: "match-stale-seed", externalId: "1557367", status: "SCHEDULED", kickoffAt: hoursBeforeTick(72) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "FT") });

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.liveListRequestCount).toBe(0);
    expect(provider.reconciliationRequests).toEqual([]);
    expect(result).toEqual({ newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [] });
    // Still rescheduled, and on the idle cadence — abandoning a row must not stall the tick.
    expect(scheduledNextPollDelayMs()).toBe(IDLE_POLL_INTERVAL_CAP_MS);
  });

  it("makes no provider call at all for an in-progress match three days past its kickoff", async () => {
    // The closed loop in its worst form: IN_PROGRESS never clears itself, and the live list can
    // never report a finished fixture, so this row would have been chased on every tick forever.
    givenDatabaseMatches([
      buildMatch({ id: "match-stuck-forever", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: hoursBeforeTick(72) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "FT") });

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.liveListRequestCount).toBe(0);
    expect(provider.reconciliationRequests).toEqual([]);
    expect(result).toEqual({ newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [] });
    expect(scheduledNextPollDelayMs()).toBe(IDLE_POLL_INTERVAL_CAP_MS);
  });

  it("still polls a match 23 hours past kickoff — one hour inside the window", async () => {
    givenDatabaseMatches([
      buildMatch({ id: "match-just-inside", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: hoursBeforeTick(23) }),
    ]);
    const provider = new ScriptedLivePollProvider([], {
      "1557367": providerFixture("1557367", "FT", { finalHomeScore: 1, finalAwayScore: 1 }),
    });

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.liveListRequestCount).toBe(1);
    expect(provider.reconciliationRequests).toEqual([["1557367"]]);
    expect(result.newlyCompletedMatchIds).toEqual(["match-just-inside"]);
  });

  it("stops polling a match 25 hours past kickoff — one hour outside the window", async () => {
    givenDatabaseMatches([
      buildMatch({ id: "match-just-outside", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: hoursBeforeTick(25) }),
    ]);
    const provider = new ScriptedLivePollProvider([], {
      "1557367": providerFixture("1557367", "FT", { finalHomeScore: 1, finalAwayScore: 1 }),
    });

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.liveListRequestCount).toBe(0);
    expect(provider.reconciliationRequests).toEqual([]);
    expect(result.newlyCompletedMatchIds).toEqual([]);
  });

  it("leaves the real reconciliation case untouched — 20 minutes past kickoff still polls and reconciles", async () => {
    // The window must not swallow the case reconciliation was built for: a fixture that has left
    // (or never appeared in) the live list minutes after its kickoff.
    givenDatabaseMatches([
      buildMatch({ id: "match-just-finished", externalId: "1557367", status: "SCHEDULED", kickoffAt: minutesBeforeTick(20) }),
    ]);
    const provider = new ScriptedLivePollProvider([], {
      "1557367": providerFixture("1557367", "FT", { finalHomeScore: 2, finalAwayScore: 0 }),
    });

    const result = await runLiveMatchPollingTick(provider);

    expect(provider.liveListRequestCount).toBe(1);
    expect(provider.reconciliationRequests).toEqual([["1557367"]]);
    expect(result.newlyCompletedMatchIds).toEqual(["match-just-finished"]);
  });

  it("polls for the matches still inside the window while abandoning the one that is not", async () => {
    givenDatabaseMatches([
      buildMatch({ id: "match-stale-seed", externalId: "1557367", status: "SCHEDULED", kickoffAt: hoursBeforeTick(72) }),
      buildMatch({ id: "match-live-now", externalId: "1557368", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
    ]);
    const provider = new ScriptedLivePollProvider([providerFixture("1557368", "2H")]);

    await runLiveMatchPollingTick(provider);

    expect(provider.liveListRequestCount).toBe(1);
    // The stale row must not be smuggled into the reconciliation batch alongside the live one.
    expect(provider.reconciliationRequests).toEqual([]);
    expect(scheduledNextPollDelayMs()).toBe(MIN_POLL_INTERVAL_MS);
  });

  it("logs the abandoned match once so it surfaces in CloudWatch instead of rotting silently", async () => {
    // The log is the feature's only remaining signal, and it has to fire on the path production
    // actually takes. givenDatabaseMatches serves this row through findPotentiallyLive's real
    // predicate — which carries no window bound — so the row genuinely reaches the tick rather than
    // being hand-fed to it. That the warning names the row is itself the proof it survived the
    // query: the worker can only report what the repository handed it.
    const abandonmentWarnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const staleRow = buildMatch({
      id: "match-stale-seed",
      externalId: "1557367",
      status: "IN_PROGRESS",
      kickoffAt: hoursBeforeTick(72),
    });
    givenDatabaseMatches([staleRow]);
    await expect(mocks.findPotentiallyLiveMatches(POLL_TICK_NOW)).resolves.toEqual([staleRow]);
    mocks.findPotentiallyLiveMatches.mockClear();

    await runLiveMatchPollingTick(new ScriptedLivePollProvider([]));

    expect(mocks.findPotentiallyLiveMatches).toHaveBeenCalledTimes(1);
    expect(abandonmentWarnings).toHaveBeenCalledTimes(1);
    const [warning] = abandonmentWarnings.mock.calls[0] as [string];
    expect(warning).toContain("[liveMatchPolling]");
    expect(warning).toContain("match-stale-seed");
    expect(warning).toContain("IN_PROGRESS");
    expect(warning).toContain(staleRow.kickoffAt.toISOString());
    abandonmentWarnings.mockRestore();
  });

  it("reports the row the repository handed it, then drops it — the query never filters it out", async () => {
    // States the division of labour directly, because it is the whole design decision: a stale row
    // must reach the worker (so it can be reported) and must not reach the provider (so it costs
    // nothing). Both halves in one tick.
    const abandonmentWarnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    givenDatabaseMatches([
      buildMatch({ id: "match-dropped-by-provider", externalId: "1557367", status: "SCHEDULED", kickoffAt: hoursBeforeTick(72) }),
    ]);
    const provider = new ScriptedLivePollProvider([], { "1557367": providerFixture("1557367", "FT") });

    await runLiveMatchPollingTick(provider);

    // Seen and reported by the worker...
    expect(abandonmentWarnings).toHaveBeenCalledTimes(1);
    expect((abandonmentWarnings.mock.calls[0] as [string])[0]).toContain("match-dropped-by-provider");
    // ...and not chased by it. The provider "knows" this fixture, so a tick that still polled would
    // have completed it — the silence is the abandonment, not a missing stub.
    expect(provider.liveListRequestCount).toBe(0);
    expect(provider.reconciliationRequests).toEqual([]);
    expect(mocks.upsertMatch).not.toHaveBeenCalled();
    abandonmentWarnings.mockRestore();
  });

  it("says nothing when every match is inside the window", async () => {
    const abandonmentWarnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    givenDatabaseMatches([
      buildMatch({ id: "match-live-now", externalId: "1557368", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
    ]);

    await runLiveMatchPollingTick(new ScriptedLivePollProvider([providerFixture("1557368", "2H")]));

    expect(abandonmentWarnings).not.toHaveBeenCalled();
    abandonmentWarnings.mockRestore();
  });
});

describe("runLiveMatchPollingTick — pacing against a constrained quota", () => {
  it("spends its remaining daily budget across the rest of the live window", async () => {
    // The free tier's 100/day, which the pacing constants were designed against — on the
    // production 7500/day plan the arithmetic always floors to MIN_POLL_INTERVAL_MS and never
    // shows itself. Three fixtures are reported live and a fourth has left the list at full time.
    //
    //   remainingQuota      = 100 - 40                     = 60
    //   budgetForRounds     = 60 - 2 * 2 confirmations     = 56
    //   requestsPerRound    = 1 live list + 1 lookup batch + 2 * 3 still live = 8
    //   rounds              = floor((56 - 2 * 3) / 8)      = 6
    //   nextDelay           = 110 min / 6                  = 18 min 20 s
    givenStoredMatches([
      buildMatch({ id: "match-finished", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(116) }),
      buildMatch({ id: "match-live-one", externalId: "1557368", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
      buildMatch({ id: "match-live-two", externalId: "1557369", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
      buildMatch({ id: "match-live-three", externalId: "1557370", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
    ]);
    const provider = new ScriptedLivePollProvider(
      [providerFixture("1557368", "2H"), providerFixture("1557369", "2H"), providerFixture("1557370", "2H")],
      { "1557367": providerFixture("1557367", "FT", { finalHomeScore: 3, finalAwayScore: 0 }) },
    );
    provider.quotaStatus = { requestsUsedToday: 40, requestsLimitPerDay: 100 };
    mocks.countOwedConfirmationPasses.mockResolvedValue(2);

    await runLiveMatchPollingTick(provider);

    expect(scheduledNextPollDelayMs()).toBe(18 * MINUTE_MS + 20 * 1000);
  });

  it("never polls faster than the provider updates, however much budget is left", async () => {
    // Same shape on the production plan: the computed interval is far below the 5-minute floor,
    // so the floor is what ships. This is the case every other pacing test in this file lands on.
    givenStoredMatches([
      buildMatch({ id: "match-live-one", externalId: "1557368", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(50) }),
    ]);
    const provider = new ScriptedLivePollProvider([providerFixture("1557368", "2H")]);

    await runLiveMatchPollingTick(provider);

    expect(scheduledNextPollDelayMs()).toBe(MIN_POLL_INTERVAL_MS);
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
    // A failed repair must never leave nextLivePollDueAt un-advanced — that would hot-loop — and
    // the fixture the live list *did* report still holds the tick on its 5-minute live cadence.
    expect(scheduledNextPollDelayMs()).toBe(MIN_POLL_INTERVAL_MS);
  });

  it("falls back to the idle cadence when the lookup fails and the live list was empty", async () => {
    // The unhappy corner of the branch above: with nothing in the live list to pace against,
    // stillLiveCount is 0 and the tick takes the 30-minute idle interval — so a failed lookup
    // slows down the very fixture it was trying to repair, the same collapse reconciliation
    // exists to prevent, for one interval. Pinned as documentation of current behaviour, not as
    // an endorsement of it (see the note in liveMatchPolling.ts).
    givenStoredMatches([
      buildMatch({ id: "match-missing", externalId: "1557367", status: "IN_PROGRESS", kickoffAt: minutesBeforeTick(116) }),
    ]);
    const provider = new ScriptedLivePollProvider([]);
    provider.reconciliationLookupError = new Error("API-Football request failed: 503 Service Unavailable (fixtures)");

    await runLiveMatchPollingTick(provider);

    expect(provider.reconciliationRequests).toEqual([["1557367"]]);
    expect(mocks.upsertMatch).not.toHaveBeenCalled();
    expect(scheduledNextPollDelayMs()).toBe(IDLE_POLL_INTERVAL_CAP_MS);
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
