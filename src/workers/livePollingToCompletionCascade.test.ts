import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION } from "../domain";
import type { Gameweek, League, Match, Team } from "../domain";
import { buildGameweek, buildLeague, buildMatch, buildTeam } from "../testing/fixtures";

/**
 * The one seam these two halves meet at: runLiveMatchPollingTick produces an ImportMatchDataResult
 * and processMatchDataChanges consumes it. Each half is well covered on its own
 * (liveMatchPolling.test.ts, processMatchDataChanges.test.ts) — but both of those mock the seam,
 * so between them nothing has ever checked that the ids the tick really emits are the ids the
 * cascade really acts on.
 *
 * That matters because awardGameweekFreeTransfers keeps no ledger — it increments every team's
 * banked transfers by 2 with no record of having done so — and live-poll reconciliation
 * (docs/stuck-live-match-reconciliation-plan.md) opened a second route into the list that drives
 * it. So here the real tick, the real importMatchData, the real transition logic and the real
 * awardGameweekFreeTransfers all run, against an in-memory stand-in for the database; only the
 * three score/standings rebuilds are mocked at the module boundary, because what they write is
 * some other test's subject and none of it feeds back into this chain.
 *
 * The in-memory store is what makes "exactly once" a real assertion rather than a restatement of
 * the mocks: a match upserted to COMPLETED by the first cycle is COMPLETED when the second cycle
 * reads it back, exactly as a database row would be.
 */
interface InMemoryDatabase {
  matchesById: Map<string, Match>;
  gameweeksById: Map<string, Gameweek>;
  teams: Team[];
  leagues: League[];
  pollState: { id: string; nextLivePollDueAt: Date | null };
}

const inMemoryDatabase = vi.hoisted<InMemoryDatabase>(() => ({
  matchesById: new Map(),
  gameweeksById: new Map(),
  teams: [],
  leagues: [],
  pollState: { id: "poll-state-singleton", nextLivePollDueAt: null },
}));

const mocks = vi.hoisted(() => ({
  incrementBankedFreeTransferCount: vi.fn(),
  findPotentiallyLiveMatches: vi.fn(),
  scheduleConfirmationPass: vi.fn(),
  insertManyPlayerMatchStats: vi.fn(),
  insertManyMatchGoalEvents: vi.fn(),
  calculatePlayerScores: vi.fn(),
  calculateTeamScores: vi.fn(),
  updateStandings: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  providerPollStateRepository: {
    getOrCreate: async () => inMemoryDatabase.pollState,
    update: async (_pollStateId: string, changes: { nextLivePollDueAt: Date }) => {
      Object.assign(inMemoryDatabase.pollState, changes);
    },
  },
  matchesRepository: {
    findPotentiallyLive: mocks.findPotentiallyLiveMatches,
    findEarliestUpcomingKickoff: async () => null,
    findByExternalId: async (externalId: string) =>
      [...inMemoryDatabase.matchesById.values()].find((match) => match.externalId === externalId) ?? null,
    upsert: async (match: Match) => {
      inMemoryDatabase.matchesById.set(match.id, match);
    },
    findById: async (matchId: string) => inMemoryDatabase.matchesById.get(matchId) ?? null,
  },
  gameweeksRepository: {
    // The real upsert only ever tightens a deadline and never touches status, so an existing
    // gameweek comes back as it stands — including a COMPLETED one, which is what lets a second
    // cycle see the first cycle's completion.
    upsertByNumber: async (gameweekNumber: number) => {
      const gameweekId = `gw-${gameweekNumber}`;
      const existing = inMemoryDatabase.gameweeksById.get(gameweekId);
      if (existing) return existing;
      const created = buildGameweek({ id: gameweekId, number: gameweekNumber, status: "IN_PROGRESS" });
      inMemoryDatabase.gameweeksById.set(gameweekId, created);
      return created;
    },
    findById: async (gameweekId: string) => inMemoryDatabase.gameweeksById.get(gameweekId) ?? null,
    // Mirrors findCurrent (gameweeks.ts): the lowest-numbered gameweek not yet COMPLETED. The whole
    // season-awareness UI hangs off this one pointer, which is why a round that cannot close pins
    // far more than its own free-transfer award.
    findCurrent: async () =>
      [...inMemoryDatabase.gameweeksById.values()]
        .filter((gameweek) => gameweek.status !== "COMPLETED")
        .sort((left, right) => left.number - right.number)[0] ?? null,
    // Reads the shared blocking-status rule rather than restating one, exactly as the real
    // repository does — a literal list here is what let this stand-in and the repository drift.
    hasEveryMatchStoppedBlockingGameweekCompletion: async (gameweekId: string) => {
      const matchesInGameweek = [...inMemoryDatabase.matchesById.values()].filter(
        (match) => match.gameweekId === gameweekId,
      );
      return (
        matchesInGameweek.length > 0 &&
        !matchesInGameweek.some((match) =>
          MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION.includes(match.status),
        )
      );
    },
    // The conditional transition, stood up the way the real UPDATE ... WHERE status <> 'COMPLETED'
    // behaves: it reports whether this call was the one that closed the round, and that answer is
    // the only thing gating the free-transfer award.
    markCompletedIfNotAlready: async (gameweekId: string) => {
      const gameweek = inMemoryDatabase.gameweeksById.get(gameweekId);
      if (!gameweek || gameweek.status === "COMPLETED") return false;
      inMemoryDatabase.gameweeksById.set(gameweekId, { ...gameweek, status: "COMPLETED" });
      return true;
    },
  },
  leaguesRepository: { findAll: async () => inMemoryDatabase.leagues },
  // No gameweek beyond the one under test has a stored table here, so the cumulative-refresh pass
  // in processMatchDataChanges has nothing to revisit.
  leagueStandingsRepository: { findGameweekIdsWithStandingsAfter: async () => [] },
  teamsRepository: {
    findAll: async () => inMemoryDatabase.teams,
    incrementBankedFreeTransferCount: mocks.incrementBankedFreeTransferCount,
    // No team in these tests rosters a player from either club, so the postponed-match award —
    // which runs for real alongside the gameweek award — contributes nothing and the banked-
    // transfer assertions below are about the gameweek award alone.
    findTeamIdsWithPlayerFromClub: async () => [],
  },
  // No players have been imported, so every provider stat line resolves to nothing. This chain is
  // about which matches complete, not about what they scored.
  playersRepository: { findByExternalId: async () => null },
  playerMatchStatsRepository: { insertMany: mocks.insertManyPlayerMatchStats },
  matchGoalEventsRepository: { insertMany: mocks.insertManyMatchGoalEvents },
  pendingConfirmationPassesRepository: {
    schedule: mocks.scheduleConfirmationPass,
    countOwed: async () => 0,
  },
}));

vi.mock("./calculatePlayerScores", () => ({ calculatePlayerScores: mocks.calculatePlayerScores }));
vi.mock("./calculateTeamScores", () => ({ calculateTeamScores: mocks.calculateTeamScores }));
vi.mock("./updateStandings", () => ({ updateStandings: mocks.updateStandings }));

import { gameweeksRepository } from "../db/repositories";
import { StubFootballDataProvider, type FootballDataProvider, type ProviderFixture } from "./footballDataProvider";
import { runLiveMatchPollingTick } from "./liveMatchPolling";
import { processMatchDataChanges } from "./processMatchDataChanges";

const GAMEWEEK_ID = "gw-1";
const GAMEWEEK_NUMBER = 1;
const STUCK_MATCH_ID = "match-arsenal-coventry";
const STUCK_MATCH_EXTERNAL_ID = "1557367";
/** Four minutes after the final whistle, when the fixture has already left the live list. */
const FIRST_CYCLE_NOW = new Date("2026-08-21T20:56:00Z");
const MINUTE_MS = 60 * 1000;

function minutesBeforeFirstCycle(minutes: number): Date {
  return new Date(FIRST_CYCLE_NOW.getTime() - minutes * MINUTE_MS);
}

function providerFixture(statusShortCode: string, overrides: Partial<ProviderFixture> = {}): ProviderFixture {
  return {
    externalId: STUCK_MATCH_EXTERNAL_ID,
    roundLabel: `Regular Season - ${GAMEWEEK_NUMBER}`,
    homeClub: "Arsenal",
    awayClub: "Coventry",
    kickoffAt: minutesBeforeFirstCycle(116),
    statusShortCode,
    finalHomeScore: null,
    finalAwayScore: null,
    ...overrides,
  };
}

/** A provider whose live list is empty — the whistle has gone, so its fixtures are no longer in
 * play — and whose targeted lookup answers with the scripted fixtures it was built with. */
class ScriptedFinishedFixtureProvider extends StubFootballDataProvider {
  private readonly reconciledFixtures: ProviderFixture[];

  constructor(...reconciledFixtures: ProviderFixture[]) {
    super();
    this.reconciledFixtures = reconciledFixtures;
  }

  override async fetchFixturesByExternalIds(externalFixtureIds: string[]): Promise<ProviderFixture[]> {
    return this.reconciledFixtures.filter((fixture) => externalFixtureIds.includes(fixture.externalId));
  }
}

/**
 * One whole worker cycle with nothing in between: the tick's genuine return value is what the
 * cascade is handed. This function is the seam under test — the production worker does exactly
 * this, and nothing here is allowed to reshape the result on the way through.
 */
async function runOneWorkerCycle(provider: FootballDataProvider): Promise<void> {
  const importResult = await runLiveMatchPollingTick(provider);
  await processMatchDataChanges(importResult);
}

function bankedFreeTransfersByTeamId(): Record<string, number> {
  return Object.fromEntries(inMemoryDatabase.teams.map((team) => [team.id, team.bankedFreeTransferCount]));
}

/** Advances past whatever the last tick scheduled, so the next cycle genuinely polls rather than
 * being waved through by the pacing guard — the point being that the cascade's own guards, not
 * the poll cadence, are what stop a second award. */
function advanceTimePastTheScheduledNextPoll(): void {
  const nextPollDueAt = inMemoryDatabase.pollState.nextLivePollDueAt;
  if (!nextPollDueAt) throw new Error("the tick scheduled no next poll");
  vi.setSystemTime(new Date(nextPollDueAt.getTime() + MINUTE_MS));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(FIRST_CYCLE_NOW);

  inMemoryDatabase.matchesById = new Map();
  inMemoryDatabase.gameweeksById = new Map([
    [GAMEWEEK_ID, buildGameweek({ id: GAMEWEEK_ID, number: GAMEWEEK_NUMBER, status: "IN_PROGRESS" })],
  ]);
  inMemoryDatabase.teams = [
    buildTeam({ id: "team-alpha", leagueId: "league-1" }),
    buildTeam({ id: "team-bravo", leagueId: "league-1" }),
  ];
  inMemoryDatabase.leagues = [buildLeague({ id: "league-1" })];
  inMemoryDatabase.pollState = { id: "poll-state-singleton", nextLivePollDueAt: null };

  mocks.incrementBankedFreeTransferCount.mockImplementation(async (teamId: string, amount = 1) => {
    const team = inMemoryDatabase.teams.find((candidate) => candidate.id === teamId);
    // The real repository caps at MAX_BANKED_FREE_TRANSFER_COUNT in SQL; leaving the cap out here
    // is deliberate, so a second award would show up as 4 rather than being clamped out of sight.
    if (team) team.bankedFreeTransferCount += amount;
  });
  mocks.findPotentiallyLiveMatches.mockImplementation(async () =>
    [...inMemoryDatabase.matchesById.values()].filter(
      (match) => match.status === "IN_PROGRESS" || match.status === "INTERRUPTED",
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

/** The round's other fixture, already played and scored, so the stuck one below is genuinely the
 * last thing standing between this gameweek and completion. */
function givenTheRoundsOtherFixtureIsAlreadyFinished(): void {
  inMemoryDatabase.matchesById.set(
    "match-brighton-fulham",
    buildMatch({
      id: "match-brighton-fulham",
      externalId: "1557300",
      gameweekId: GAMEWEEK_ID,
      status: "COMPLETED",
      kickoffAt: minutesBeforeFirstCycle(240),
    }),
  );
}

function givenTheStuckMatchIsStillInProgress(): void {
  inMemoryDatabase.matchesById.set(
    STUCK_MATCH_ID,
    buildMatch({
      id: STUCK_MATCH_ID,
      externalId: STUCK_MATCH_EXTERNAL_ID,
      gameweekId: GAMEWEEK_ID,
      homeClub: "Arsenal",
      awayClub: "Coventry",
      status: "IN_PROGRESS",
      kickoffAt: minutesBeforeFirstCycle(116),
    }),
  );
}

describe("live-poll tick to completion cascade — the real seam, end to end", () => {
  it("completes the gameweek and awards each team exactly 2 free transfers when reconciliation resolves the round's last fixture at full time", async () => {
    givenTheRoundsOtherFixtureIsAlreadyFinished();
    givenTheStuckMatchIsStillInProgress();
    const provider = new ScriptedFinishedFixtureProvider(
      providerFixture("FT", { finalHomeScore: 3, finalAwayScore: 0 }),
    );

    await runOneWorkerCycle(provider);

    // The tick's real output reached the cascade: the match it named is the match that was scored.
    expect(mocks.calculatePlayerScores).toHaveBeenCalledTimes(1);
    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith(STUCK_MATCH_ID);
    expect(inMemoryDatabase.matchesById.get(STUCK_MATCH_ID)?.status).toBe("COMPLETED");
    expect(inMemoryDatabase.gameweeksById.get(GAMEWEEK_ID)?.status).toBe("COMPLETED");
    expect(bankedFreeTransfersByTeamId()).toEqual({ "team-alpha": 2, "team-bravo": 2 });
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.updateStandings).toHaveBeenCalledWith("league-1", GAMEWEEK_ID);
  });

  it("does not award a second helping of free transfers when the next cycle runs and the provider still reports FT", async () => {
    givenTheRoundsOtherFixtureIsAlreadyFinished();
    givenTheStuckMatchIsStillInProgress();
    const finishedFixture = providerFixture("FT", { finalHomeScore: 3, finalAwayScore: 0 });

    await runOneWorkerCycle(new ScriptedFinishedFixtureProvider(finishedFixture));
    expect(bankedFreeTransfersByTeamId()).toEqual({ "team-alpha": 2, "team-bravo": 2 });

    advanceTimePastTheScheduledNextPoll();
    await runOneWorkerCycle(new ScriptedFinishedFixtureProvider(finishedFixture));

    // The match is COMPLETED in the store now, so it is no longer offered to the tick as possibly
    // live and nothing reaches the cascade at all — the first of the guards, and the cheapest.
    expect(bankedFreeTransfersByTeamId()).toEqual({ "team-alpha": 2, "team-bravo": 2 });
    expect(mocks.incrementBankedFreeTransferCount).toHaveBeenCalledTimes(2);
  });

  it("still awards nothing extra when a stale row keeps the finished fixture in the reconciliation set", async () => {
    // Defence in depth for the same seam: force the tick to ask about a fixture that is already
    // COMPLETED on our side. importMatchData must report no new completion (it transitions only on
    // a genuine status change) and, behind it, the gameweek's own COMPLETED guard must hold.
    givenTheRoundsOtherFixtureIsAlreadyFinished();
    givenTheStuckMatchIsStillInProgress();
    const finishedFixture = providerFixture("FT", { finalHomeScore: 3, finalAwayScore: 0 });

    await runOneWorkerCycle(new ScriptedFinishedFixtureProvider(finishedFixture));

    advanceTimePastTheScheduledNextPoll();
    const staleInProgressView = { ...inMemoryDatabase.matchesById.get(STUCK_MATCH_ID)!, status: "IN_PROGRESS" as const };
    mocks.findPotentiallyLiveMatches.mockResolvedValueOnce([staleInProgressView]);

    await runOneWorkerCycle(new ScriptedFinishedFixtureProvider(finishedFixture));

    expect(bankedFreeTransfersByTeamId()).toEqual({ "team-alpha": 2, "team-bravo": 2 });
    expect(mocks.calculatePlayerScores).toHaveBeenCalledTimes(1);
    // A confirmation re-poll is scheduled on the transition, so a second one would mean a second
    // transition had been reported.
    expect(mocks.scheduleConfirmationPass).toHaveBeenCalledTimes(1);
  });

  it("completes the gameweek through the same seam when reconciliation resolves the round's last fixture as abandoned", async () => {
    // The VOID counterpart of the first case. An abandoned fixture arrives on newlyDisruptedMatchIds
    // and never on newlyCompletedMatchIds, yet VOIDED is a final state — so this is the round's
    // last unresolved match reaching a final state without a single completion to announce it.
    givenTheRoundsOtherFixtureIsAlreadyFinished();
    givenTheStuckMatchIsStillInProgress();
    const provider = new ScriptedFinishedFixtureProvider(providerFixture("ABD"));

    await runOneWorkerCycle(provider);

    expect(inMemoryDatabase.matchesById.get(STUCK_MATCH_ID)?.status).toBe("VOIDED");
    expect(mocks.calculatePlayerScores).not.toHaveBeenCalled();
    expect(inMemoryDatabase.gameweeksById.get(GAMEWEEK_ID)?.status).toBe("COMPLETED");
    expect(bankedFreeTransfersByTeamId()).toEqual({ "team-alpha": 2, "team-bravo": 2 });
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.updateStandings).toHaveBeenCalledWith("league-1", GAMEWEEK_ID);
  });

  it("leaves the gameweek open, and awards nothing, while the round's other fixture is still to be played", async () => {
    // Same full-time reconciliation, but this round has a fixture that has not reached a final
    // state — the guard that keeps the ledger-less award tied to a genuinely finished gameweek.
    inMemoryDatabase.matchesById.set(
      "match-brighton-fulham",
      buildMatch({
        id: "match-brighton-fulham",
        externalId: "1557300",
        gameweekId: GAMEWEEK_ID,
        status: "SCHEDULED",
        kickoffAt: new Date(FIRST_CYCLE_NOW.getTime() + 24 * 60 * MINUTE_MS),
      }),
    );
    givenTheStuckMatchIsStillInProgress();
    const provider = new ScriptedFinishedFixtureProvider(
      providerFixture("FT", { finalHomeScore: 3, finalAwayScore: 0 }),
    );

    await runOneWorkerCycle(provider);

    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith(STUCK_MATCH_ID);
    expect(inMemoryDatabase.gameweeksById.get(GAMEWEEK_ID)?.status).toBe("IN_PROGRESS");
    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
    // The provisional table still gets rebuilt, so the leaderboard moves through the matchday.
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
  });

  it("closes the round, and pays it, with a postponed fixture still outstanding", async () => {
    // Nine fixtures played, one put off to a later date. The round is settled as far as anyone can
    // settle it, so withholding its 2 free transfers from every manager until the replay — weeks,
    // sometimes — bought nothing: the managers who actually lost players to the postponement are
    // compensated separately by awardPostponedMatchTransfers.
    inMemoryDatabase.matchesById.set(
      "match-brighton-fulham",
      buildMatch({
        id: "match-brighton-fulham",
        externalId: "1557300",
        gameweekId: GAMEWEEK_ID,
        status: "POSTPONED",
        kickoffAt: minutesBeforeFirstCycle(240),
      }),
    );
    givenTheStuckMatchIsStillInProgress();
    const provider = new ScriptedFinishedFixtureProvider(
      providerFixture("FT", { finalHomeScore: 3, finalAwayScore: 0 }),
    );

    await runOneWorkerCycle(provider);

    expect(inMemoryDatabase.gameweeksById.get(GAMEWEEK_ID)?.status).toBe("COMPLETED");
    expect(bankedFreeTransfersByTeamId()).toEqual({ "team-alpha": 2, "team-bravo": 2 });
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
  });

  it("rebuilds, but does not pay again, when the postponed fixture is finally replayed weeks later", async () => {
    // The other half of closing a round early: the replay still has to score into the round it
    // belonged to. Nothing but gameweeksRepository.markCompletedIfNotAlready stands between this
    // second, entirely genuine completion and a second helping of free transfers — the round is
    // already COMPLETED, so its conditional UPDATE changes nothing and reports false.
    const postponedFixture = buildMatch({
      id: "match-brighton-fulham",
      externalId: "1557300",
      gameweekId: GAMEWEEK_ID,
      status: "POSTPONED",
      kickoffAt: minutesBeforeFirstCycle(240),
    });
    inMemoryDatabase.matchesById.set(postponedFixture.id, postponedFixture);
    givenTheStuckMatchIsStillInProgress();

    await runOneWorkerCycle(
      new ScriptedFinishedFixtureProvider(providerFixture("FT", { finalHomeScore: 3, finalAwayScore: 0 })),
    );
    expect(bankedFreeTransfersByTeamId()).toEqual({ "team-alpha": 2, "team-bravo": 2 });

    advanceTimePastTheScheduledNextPoll();
    mocks.calculateTeamScores.mockClear();
    // The replay kicks off and finishes, so the poller is now chasing the fixture that was put off.
    mocks.findPotentiallyLiveMatches.mockResolvedValueOnce([{ ...postponedFixture, status: "IN_PROGRESS" as const }]);

    await runOneWorkerCycle(
      new ScriptedFinishedFixtureProvider(
        providerFixture("FT", { externalId: "1557300", finalHomeScore: 0, finalAwayScore: 2 }),
      ),
    );

    expect(inMemoryDatabase.matchesById.get(postponedFixture.id)?.status).toBe("COMPLETED");
    expect(bankedFreeTransfersByTeamId()).toEqual({ "team-alpha": 2, "team-bravo": 2 });
    // The scores it just produced still reach the round's table — and, via the cumulative refresh
    // inside rebuildGameweekScoresAndStandings, every later round's table too.
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
  });

  it("lets the season move on: findCurrent advances past a round closed with a postponement outstanding", async () => {
    // The consequence nobody had logged. findCurrent is "the lowest-numbered non-COMPLETED
    // gameweek", and the entire season-awareness layer reads it — gameweek banner, transfer/lineup
    // lock context, standings labels. A round that could not close therefore pinned the whole UI to
    // itself while later rounds were being played, not just its own free-transfer award.
    inMemoryDatabase.gameweeksById.set(
      "gw-2",
      buildGameweek({ id: "gw-2", number: 2, status: "UPCOMING" }),
    );
    inMemoryDatabase.matchesById.set(
      "match-brighton-fulham",
      buildMatch({
        id: "match-brighton-fulham",
        externalId: "1557300",
        gameweekId: GAMEWEEK_ID,
        status: "POSTPONED",
        kickoffAt: minutesBeforeFirstCycle(240),
      }),
    );
    givenTheStuckMatchIsStillInProgress();
    expect((await gameweeksRepository.findCurrent())?.number).toBe(GAMEWEEK_NUMBER);

    await runOneWorkerCycle(
      new ScriptedFinishedFixtureProvider(providerFixture("FT", { finalHomeScore: 3, finalAwayScore: 0 })),
    );

    expect((await gameweeksRepository.findCurrent())?.number).toBe(2);
  });
});

describe("live-poll tick to completion cascade — two rounds settling in one cycle", () => {
  /* The +4 case at the seam where a duplicate award would actually hide, since the in-memory store
   * carries state between the two halves the way a database row does.
   *
   * A Gameweek 10 fixture postponed into the Gameweek 12 weekend is replayed there, so a single
   * tick can carry the last outstanding fixture of two different rounds. Every manager banking
   * 2 + 2 is correct — 2 free transfers are earned per gameweek, and one of these two rounds is
   * simply being paid late — so the assertion is 4, not a capped 2. What must never happen is one
   * round paying twice, which the next test pins from the other side. */

  const EARLIER_GAMEWEEK_ID = "gw-10";
  const LATER_GAMEWEEK_ID = "gw-12";
  const REPLAYED_MATCH_ID = "match-replayed-from-gw-10";
  const REPLAYED_MATCH_EXTERNAL_ID = "1557410";
  const LATE_MATCH_ID = "match-monday-night-of-gw-12";
  const LATE_MATCH_EXTERNAL_ID = "1557520";

  beforeEach(() => {
    inMemoryDatabase.gameweeksById = new Map([
      [EARLIER_GAMEWEEK_ID, buildGameweek({ id: EARLIER_GAMEWEEK_ID, number: 10, status: "IN_PROGRESS" })],
      [LATER_GAMEWEEK_ID, buildGameweek({ id: LATER_GAMEWEEK_ID, number: 12, status: "IN_PROGRESS" })],
    ]);
    inMemoryDatabase.matchesById = new Map([
      // Each round's other fixtures are already done, so the two matches below are the last thing
      // standing between each round and its settlement.
      [
        "match-gw-10-already-played",
        buildMatch({ id: "match-gw-10-already-played", externalId: "1557400", gameweekId: EARLIER_GAMEWEEK_ID, status: "COMPLETED" }),
      ],
      [
        "match-gw-12-already-played",
        buildMatch({ id: "match-gw-12-already-played", externalId: "1557500", gameweekId: LATER_GAMEWEEK_ID, status: "COMPLETED" }),
      ],
      [
        REPLAYED_MATCH_ID,
        buildMatch({
          id: REPLAYED_MATCH_ID,
          externalId: REPLAYED_MATCH_EXTERNAL_ID,
          gameweekId: EARLIER_GAMEWEEK_ID,
          status: "IN_PROGRESS",
          kickoffAt: minutesBeforeFirstCycle(116),
        }),
      ],
      [
        LATE_MATCH_ID,
        buildMatch({
          id: LATE_MATCH_ID,
          externalId: LATE_MATCH_EXTERNAL_ID,
          gameweekId: LATER_GAMEWEEK_ID,
          status: "IN_PROGRESS",
          kickoffAt: minutesBeforeFirstCycle(116),
        }),
      ],
    ]);
  });

  function bothRoundsReachingFullTime(): ScriptedFinishedFixtureProvider {
    return new ScriptedFinishedFixtureProvider(
      providerFixture("FT", {
        externalId: REPLAYED_MATCH_EXTERNAL_ID,
        roundLabel: "Regular Season - 10",
        finalHomeScore: 1,
        finalAwayScore: 1,
      }),
      providerFixture("FT", {
        externalId: LATE_MATCH_EXTERNAL_ID,
        roundLabel: "Regular Season - 12",
        finalHomeScore: 2,
        finalAwayScore: 0,
      }),
    );
  }

  it("closes both rounds and pays each team 2 free transfers for each of them", async () => {
    await runOneWorkerCycle(bothRoundsReachingFullTime());

    expect(inMemoryDatabase.gameweeksById.get(EARLIER_GAMEWEEK_ID)?.status).toBe("COMPLETED");
    expect(inMemoryDatabase.gameweeksById.get(LATER_GAMEWEEK_ID)?.status).toBe("COMPLETED");
    // 2 per round, two rounds — a correct settlement, one round of it overdue. Not a double award.
    expect(bankedFreeTransfersByTeamId()).toEqual({ "team-alpha": 4, "team-bravo": 4 });
    expect(mocks.calculateTeamScores.mock.calls).toEqual([[EARLIER_GAMEWEEK_ID], [LATER_GAMEWEEK_ID]]);
  });

  it("pays neither round a second time when the next cycle sees the same two fixtures again", async () => {
    await runOneWorkerCycle(bothRoundsReachingFullTime());

    advanceTimePastTheScheduledNextPoll();
    // Force both finished fixtures back into the reconciliation set, as a stale row would: the
    // conditional close is then the only thing between them and a second award.
    mocks.findPotentiallyLiveMatches.mockResolvedValueOnce([
      { ...inMemoryDatabase.matchesById.get(REPLAYED_MATCH_ID)!, status: "IN_PROGRESS" as const },
      { ...inMemoryDatabase.matchesById.get(LATE_MATCH_ID)!, status: "IN_PROGRESS" as const },
    ]);

    await runOneWorkerCycle(bothRoundsReachingFullTime());

    expect(bankedFreeTransfersByTeamId()).toEqual({ "team-alpha": 4, "team-bravo": 4 });
  });
});
