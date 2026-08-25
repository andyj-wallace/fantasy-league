import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMatch } from "../testing/fixtures";
import { StubFootballDataProvider } from "./footballDataProvider";

/**
 * Regression coverage for the 2026-08-24 "GW 1 points not written bug" (commit 811b1c6): a late
 * provider correction landing after the affected gameweek is already COMPLETED must still reach
 * TeamScore/LeagueStanding, not just PlayerScore — see the revised doc comment on
 * runDueConfirmationPasses. This file previously had no coverage at all.
 */
interface PendingConfirmationPass {
  id: string;
  matchId: string;
  externalFixtureId: string;
  dueAt: Date;
}

function buildPendingConfirmationPass(overrides: Partial<PendingConfirmationPass> = {}): PendingConfirmationPass {
  return {
    id: overrides.id ?? "pass-1",
    matchId: overrides.matchId ?? "match-1",
    externalFixtureId: overrides.externalFixtureId ?? "external-1",
    dueAt: overrides.dueAt ?? new Date("2026-08-24T18:00:00Z"),
  };
}

const mocks = vi.hoisted(() => ({
  findDuePasses: vi.fn(),
  removePass: vi.fn(),
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
  pendingConfirmationPassesRepository: { findDue: mocks.findDuePasses, remove: mocks.removePass },
  playerMatchStatsRepository: { replaceForMatch: mocks.replaceStatsForMatch },
  matchGoalEventsRepository: { replaceForMatch: mocks.replaceGoalEventsForMatch },
  matchesRepository: { findById: mocks.findMatchById },
  // Not imported by confirmationPasses.ts today — kept as a tripwire so a future edit that starts
  // re-running the one-shot completion actions here fails a test rather than double-awarding.
  gameweeksRepository: { markCompleted: mocks.markGameweekCompleted },
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

import { runDueConfirmationPasses } from "./confirmationPasses";

const provider = new StubFootballDataProvider();

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
