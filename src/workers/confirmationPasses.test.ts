import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMatch } from "../testing/fixtures";
import { StubFootballDataProvider, type ProviderFixtureDetail, type ProviderPlayerMatchStat } from "./footballDataProvider";

/**
 * Regression coverage for the 2026-08-24 "GW 1 points not written bug" (commit 811b1c6): a late
 * provider correction landing after the affected gameweek is already COMPLETED must still reach
 * TeamScore/LeagueStanding, not just PlayerScore — see the revised doc comment on
 * runDueConfirmationPasses. This file previously had no coverage at all.
 *
 * The second describe block covers the 2026-08-26 failure-containment work: before it, every await
 * in the pass loop was unguarded, so one bad pass abandoned the rest of the batch *and* the two
 * worker-cycle stages that follow it.
 */
interface PendingConfirmationPass {
  id: string;
  matchId: string;
  externalFixtureId: string;
  dueAt: Date;
  attemptCount: number;
  lastAttemptedAt: Date | null;
  lastError: string | null;
}

function buildPendingConfirmationPass(overrides: Partial<PendingConfirmationPass> = {}): PendingConfirmationPass {
  return {
    id: overrides.id ?? "pass-1",
    matchId: overrides.matchId ?? "match-1",
    externalFixtureId: overrides.externalFixtureId ?? "external-1",
    dueAt: overrides.dueAt ?? new Date("2026-08-24T18:00:00Z"),
    attemptCount: overrides.attemptCount ?? 0,
    lastAttemptedAt: overrides.lastAttemptedAt ?? null,
    lastError: overrides.lastError ?? null,
  };
}

function buildProviderPlayerMatchStat(): ProviderPlayerMatchStat {
  return {
    externalPlayerId: "external-player-1",
    minutesPlayed: 90,
    goalsScored: 0,
    assists: 0,
    savesCount: 0,
    ownGoalsScored: 0,
    penaltiesWon: 0,
    penaltiesConceded: 0,
    receivedYellowCard: false,
    receivedRedCard: false,
    wasInStartingLineup: true,
  };
}

/**
 * StubFootballDataProvider answers every fixture-detail poll with an *empty* stat set — which is
 * exactly what ApiFootballProvider does when coverage is off, and which runDueConfirmationPasses
 * now refuses to write over a COMPLETED match's stats. So every case that expects a correction to
 * actually land needs a provider with something in it; `externalFixtureIdsThatFail` covers the
 * other half, a provider call that throws outright.
 */
class ConfirmationPassProvider extends StubFootballDataProvider {
  constructor(private readonly externalFixtureIdsThatFail: ReadonlySet<string> = new Set()) {
    super();
  }

  override async fetchFixturePlayerStatsAndGoalEvents(externalFixtureId: string): Promise<ProviderFixtureDetail> {
    if (this.externalFixtureIdsThatFail.has(externalFixtureId)) {
      throw new Error(`provider unavailable for ${externalFixtureId}`);
    }
    return { playerStats: [buildProviderPlayerMatchStat()], goalEvents: [] };
  }
}

const mocks = vi.hoisted(() => ({
  findDuePasses: vi.fn(),
  removePass: vi.fn(),
  recordFailedConfirmationPassAttempt: vi.fn(),
  replaceStatsForMatch: vi.fn(),
  replaceGoalEventsForMatch: vi.fn(),
  findMatchById: vi.fn(),
  markGameweekCompleted: vi.fn(),
  calculatePlayerScores: vi.fn(),
  resolvePlayerMatchStats: vi.fn(),
  resolveMatchGoalEvents: vi.fn(),
  rebuildGameweekScoresAndStandings: vi.fn(),
  awardGameweekFreeTransfers: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  pendingConfirmationPassesRepository: {
    findDue: mocks.findDuePasses,
    remove: mocks.removePass,
    recordFailedAttempt: mocks.recordFailedConfirmationPassAttempt,
  },
  playerMatchStatsRepository: { replaceForMatch: mocks.replaceStatsForMatch },
  matchGoalEventsRepository: { replaceForMatch: mocks.replaceGoalEventsForMatch },
  matchesRepository: { findById: mocks.findMatchById },
  // Not imported by confirmationPasses.ts today — kept as a tripwire so a future edit that starts
  // re-running the one-shot completion actions here fails a test rather than double-awarding.
  gameweeksRepository: { markCompletedIfNotAlready: mocks.markGameweekCompleted },
}));

vi.mock("./calculatePlayerScores", () => ({ calculatePlayerScores: mocks.calculatePlayerScores }));
vi.mock("./importMatchData", () => ({
  resolvePlayerMatchStats: mocks.resolvePlayerMatchStats,
  resolveMatchGoalEvents: mocks.resolveMatchGoalEvents,
}));
vi.mock("./rebuildGameweekScoresAndStandings", () => ({
  rebuildGameweekScoresAndStandings: mocks.rebuildGameweekScoresAndStandings,
}));
// Also not imported by confirmationPasses.ts — same tripwire reasoning as gameweeksRepository above.
vi.mock("./awardGameweekFreeTransfers", () => ({ awardGameweekFreeTransfers: mocks.awardGameweekFreeTransfers }));

import { MAX_CONFIRMATION_PASS_ATTEMPTS, runDueConfirmationPasses } from "./confirmationPasses";

const provider = new ConfirmationPassProvider();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolvePlayerMatchStats.mockResolvedValue([]);
  mocks.resolveMatchGoalEvents.mockResolvedValue([]);
});

describe("runDueConfirmationPasses", () => {
  it("does nothing when no pass is due", async () => {
    mocks.findDuePasses.mockResolvedValue([]);

    await runDueConfirmationPasses(provider);

    expect(mocks.calculatePlayerScores).not.toHaveBeenCalled();
    expect(mocks.rebuildGameweekScoresAndStandings).not.toHaveBeenCalled();
  });

  it("replaces stats/goal-events, recalculates the match's score, removes the pass, and rebuilds its still-open gameweek (no regression)", async () => {
    const pass = buildPendingConfirmationPass({ matchId: "match-1" });
    mocks.findDuePasses.mockResolvedValue([pass]);
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: "match-1", gameweekId: "gw-open" }));

    await runDueConfirmationPasses(provider);

    expect(mocks.replaceStatsForMatch).toHaveBeenCalledWith("match-1", []);
    expect(mocks.replaceGoalEventsForMatch).toHaveBeenCalledWith("match-1", []);
    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith("match-1");
    expect(mocks.removePass).toHaveBeenCalledWith(pass.id);
    expect(mocks.rebuildGameweekScoresAndStandings).toHaveBeenCalledWith("gw-open");
  });

  it("rebuilds scores/standings even when the pass's gameweek is already COMPLETED, and never re-runs the one-shot completion actions", async () => {
    // This is the actual fix: previously, a correction landing after gameweek close would recompute
    // PlayerScore and stop there, leaving TeamScore/LeagueStanding permanently stale — exactly the
    // 2026-08-24 incident. gameweek.status is not even read here anymore; the rebuild always fires.
    const pass = buildPendingConfirmationPass({ matchId: "match-1" });
    mocks.findDuePasses.mockResolvedValue([pass]);
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: "match-1", gameweekId: "gw-completed" }));

    await runDueConfirmationPasses(provider);

    expect(mocks.rebuildGameweekScoresAndStandings).toHaveBeenCalledWith("gw-completed");
    expect(mocks.markGameweekCompleted).not.toHaveBeenCalled();
    expect(mocks.awardGameweekFreeTransfers).not.toHaveBeenCalled();
  });

  it("rebuilds a gameweek touched by two due passes only once", async () => {
    const passA = buildPendingConfirmationPass({ id: "pass-a", matchId: "match-a" });
    const passB = buildPendingConfirmationPass({ id: "pass-b", matchId: "match-b" });
    mocks.findDuePasses.mockResolvedValue([passA, passB]);
    mocks.findMatchById.mockImplementation(async (matchId: string) => buildMatch({ id: matchId, gameweekId: "gw-1" }));

    await runDueConfirmationPasses(provider);

    expect(mocks.rebuildGameweekScoresAndStandings).toHaveBeenCalledTimes(1);
    expect(mocks.rebuildGameweekScoresAndStandings).toHaveBeenCalledWith("gw-1");
  });

  it("rebuilds each distinct gameweek touched by due passes in the same cycle", async () => {
    const passA = buildPendingConfirmationPass({ id: "pass-a", matchId: "match-a" });
    const passB = buildPendingConfirmationPass({ id: "pass-b", matchId: "match-b" });
    mocks.findDuePasses.mockResolvedValue([passA, passB]);
    mocks.findMatchById.mockImplementation(async (matchId: string) =>
      buildMatch({ id: matchId, gameweekId: matchId === "match-a" ? "gw-1" : "gw-2" }),
    );

    await runDueConfirmationPasses(provider);

    expect(mocks.rebuildGameweekScoresAndStandings).toHaveBeenCalledTimes(2);
    expect(mocks.rebuildGameweekScoresAndStandings).toHaveBeenCalledWith("gw-1");
    expect(mocks.rebuildGameweekScoresAndStandings).toHaveBeenCalledWith("gw-2");
  });

  it("still corrects a pass's own stats/score even if its match can no longer be found, but skips the rebuild for it", async () => {
    const pass = buildPendingConfirmationPass({ matchId: "match-vanished" });
    mocks.findDuePasses.mockResolvedValue([pass]);
    mocks.findMatchById.mockResolvedValue(null);

    await runDueConfirmationPasses(provider);

    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith("match-vanished");
    expect(mocks.removePass).toHaveBeenCalledWith(pass.id);
    expect(mocks.rebuildGameweekScoresAndStandings).not.toHaveBeenCalled();
  });
});

/**
 * Before 2026-08-26 the pass loop had six unguarded awaits ahead of `remove(pass.id)`. Any throw
 * left the row in place with its already-past dueAt untouched, so it came due again on the very
 * next cycle, forever — and because nothing up the stack caught it either, the throw also cost the
 * cycle its live poll and permanently discarded that cycle's discovery completions. See
 * confirmationPassFailureContainment.test.ts for that second half.
 */
describe("runDueConfirmationPasses failure handling", () => {
  const now = new Date("2026-08-26T18:00:00.000Z");
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  const CAPPED_RETRY_DELAY_MS = 30 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a pass whose provider call threw, defers it with a longer dueAt, and still processes the next pass in the batch", async () => {
    // The core regression. findDue has no ORDER BY and no LIMIT, so a single bad pass sitting at
    // the head of the array used to block every later pass in it as well.
    const failingPass = buildPendingConfirmationPass({
      id: "pass-failing",
      matchId: "match-failing",
      externalFixtureId: "fixture-failing",
    });
    const healthyPass = buildPendingConfirmationPass({
      id: "pass-healthy",
      matchId: "match-healthy",
      externalFixtureId: "fixture-healthy",
    });
    mocks.findDuePasses.mockResolvedValue([failingPass, healthyPass]);
    mocks.findMatchById.mockImplementation(async (matchId: string) => buildMatch({ id: matchId, gameweekId: "gw-1" }));

    await runDueConfirmationPasses(new ConfirmationPassProvider(new Set(["fixture-failing"])));

    expect(mocks.removePass).not.toHaveBeenCalledWith("pass-failing");
    expect(mocks.recordFailedConfirmationPassAttempt).toHaveBeenCalledWith("pass-failing", {
      attemptCount: 1,
      lastAttemptedAt: now,
      lastError: expect.stringContaining("fixture-failing"),
      nextDueAt: new Date(now.getTime() + FIVE_MINUTES_MS),
    });
    expect(new Date(now.getTime() + FIVE_MINUTES_MS).getTime()).toBeGreaterThan(failingPass.dueAt.getTime());

    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith("match-healthy");
    expect(mocks.removePass).toHaveBeenCalledWith("pass-healthy");
    expect(mocks.rebuildGameweekScoresAndStandings).toHaveBeenCalledWith("gw-1");
  });

  it("widens the retry delay as attempts accumulate, up to the cap", async () => {
    const alreadyRetriedPass = buildPendingConfirmationPass({
      id: "pass-retried",
      externalFixtureId: "fixture-retried",
      attemptCount: MAX_CONFIRMATION_PASS_ATTEMPTS - 2,
    });
    mocks.findDuePasses.mockResolvedValue([alreadyRetriedPass]);
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: "match-1", gameweekId: "gw-1" }));

    await runDueConfirmationPasses(new ConfirmationPassProvider(new Set(["fixture-retried"])));

    expect(mocks.recordFailedConfirmationPassAttempt).toHaveBeenCalledWith(
      "pass-retried",
      expect.objectContaining({
        attemptCount: MAX_CONFIRMATION_PASS_ATTEMPTS - 1,
        nextDueAt: new Date(now.getTime() + CAPPED_RETRY_DELAY_MS),
      }),
    );
  });

  it("abandons a pass that fails on its final permitted attempt, logging the match and fixture loudly", async () => {
    const exhaustedPass = buildPendingConfirmationPass({
      id: "pass-exhausted",
      matchId: "match-exhausted",
      externalFixtureId: "fixture-exhausted",
      attemptCount: MAX_CONFIRMATION_PASS_ATTEMPTS - 1,
    });
    mocks.findDuePasses.mockResolvedValue([exhaustedPass]);
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: "match-exhausted", gameweekId: "gw-1" }));

    await runDueConfirmationPasses(new ConfirmationPassProvider(new Set(["fixture-exhausted"])));

    expect(mocks.recordFailedConfirmationPassAttempt).not.toHaveBeenCalled();
    expect(mocks.removePass).toHaveBeenCalledWith("pass-exhausted");

    const abandonmentLog = String(vi.mocked(console.error).mock.calls[0]?.[0] ?? "");
    expect(abandonmentLog).toContain("match-exhausted");
    expect(abandonmentLog).toContain("fixture-exhausted");
    expect(abandonmentLog).toContain("provider unavailable for fixture-exhausted");

    // Nothing was corrected, so there is nothing to rebuild — the match keeps the stats it was
    // imported with.
    expect(mocks.rebuildGameweekScoresAndStandings).not.toHaveBeenCalled();
  });

  it("never records an attempt count at the cap, which is what lets countOwed count every row it finds", async () => {
    // countOwed reserves 2 provider calls for every row in pending_confirmation_passes
    // (docs/polling-budget.md). That is only honest while every stored row is one that will
    // actually be attempted, and what guarantees it is the ordering inside
    // deferOrAbandonFailedConfirmationPass: the cap is checked *before* the attempt is written, so
    // a doomed pass is deleted rather than left sitting at MAX_CONFIRMATION_PASS_ATTEMPTS. Drive
    // one through its whole life, exactly as successive worker cycles would.
    const doomedPass = buildPendingConfirmationPass({ id: "pass-doomed", externalFixtureId: "fixture-doomed" });
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: "match-1", gameweekId: "gw-1" }));
    const provider = new ConfirmationPassProvider(new Set(["fixture-doomed"]));

    const recordedAttemptCounts = (): number[] =>
      mocks.recordFailedConfirmationPassAttempt.mock.calls.map(([, attempt]) => attempt.attemptCount);

    for (let cycle = 0; cycle < MAX_CONFIRMATION_PASS_ATTEMPTS; cycle += 1) {
      // Each cycle re-reads the pass with whatever the previous cycle persisted on it.
      mocks.findDuePasses.mockResolvedValue([{ ...doomedPass, attemptCount: recordedAttemptCounts().at(-1) ?? 0 }]);
      await runDueConfirmationPasses(provider);
    }

    expect(recordedAttemptCounts()).toEqual([1, 2, 3, 4]);
    expect(Math.max(...recordedAttemptCounts())).toBeLessThan(MAX_CONFIRMATION_PASS_ATTEMPTS);
    expect(mocks.removePass).toHaveBeenCalledWith("pass-doomed");
    expect(mocks.removePass).toHaveBeenCalledTimes(1);
  });

  it("skips a COMPLETED match whose provider stats came back empty instead of zeroing them", async () => {
    // ApiFootballProvider.fetchFixturePlayerStatsAndGoalEvents returns an empty set rather than
    // throwing when statistics_players coverage is off. Feeding that to replaceForMatch would wipe
    // every player's stat line for a match that definitely had one — strictly worse than the
    // stuck-pass bug this whole block is about.
    const pass = buildPendingConfirmationPass({ id: "pass-uncovered", matchId: "match-uncovered" });
    mocks.findDuePasses.mockResolvedValue([pass]);
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: "match-uncovered", gameweekId: "gw-1", status: "COMPLETED" }));

    await runDueConfirmationPasses(new StubFootballDataProvider());

    expect(mocks.replaceStatsForMatch).not.toHaveBeenCalled();
    expect(mocks.replaceGoalEventsForMatch).not.toHaveBeenCalled();
    expect(mocks.calculatePlayerScores).not.toHaveBeenCalled();
    expect(mocks.removePass).not.toHaveBeenCalled();
    expect(mocks.rebuildGameweekScoresAndStandings).not.toHaveBeenCalled();
    expect(mocks.recordFailedConfirmationPassAttempt).toHaveBeenCalledWith(
      "pass-uncovered",
      expect.objectContaining({ attemptCount: 1 }),
    );
  });
});
