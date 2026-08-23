import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerGameweekPoints, TeamScore } from "../domain";
import { buildTeam } from "../testing/fixtures";

/**
 * Unit tests for the team-aggregation and captaincy rules in calculateTeamScores. Repositories are
 * mocked: we describe each team's roster and each player's gameweek score in-memory, then assert on
 * the TeamScore rows handed to teamScoresRepository.replaceForGameweek. Focus is the captain 2x
 * bonus and its fall back to the vice-captain, that bench players count directly (no auto-subs),
 * and that the gameweek's paid transfers are charged against the total.
 */
const GAMEWEEK_ID = "gw1";

const mocks = vi.hoisted(() => ({
  findAllTeams: vi.fn(),
  findRosterSlots: vi.fn(),
  findPlayerGameweekPoints: vi.fn(),
  replaceForGameweek: vi.fn(),
  sumTransferPointsCostByTeamForGameweek: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  teamsRepository: { findAll: mocks.findAllTeams, findRosterSlots: mocks.findRosterSlots },
  playerScoresRepository: { findPlayerGameweekPoints: mocks.findPlayerGameweekPoints },
  teamScoresRepository: { replaceForGameweek: mocks.replaceForGameweek },
  transfersRepository: { sumTransferPointsCostByTeamForGameweek: mocks.sumTransferPointsCostByTeamForGameweek },
}));

import { calculateTeamScores } from "./calculateTeamScores";

/** The collapsed per-gameweek shape calculateTeamScores reads. `didAppear` defaults to true;
 * pass false to simulate a scored player who didn't take the field (e.g. an unused substitute
 * reported with 0 minutes), which is ineligible for the captain bonus. */
function playerGameweekPointsOf(totalPoints: number, didAppear = true): PlayerGameweekPoints {
  return { totalPoints, didAppear };
}

/**
 * Sets up a single team whose roster is `rosterPlayerIds` (all starters unless noted) and whose
 * players have the given per-gameweek points, then runs the scorer and returns the one TeamScore.
 * `didNotAppearPlayerIds` marks players who have a scored row but never took the field (an
 * unused sub) rather than no row at all.
 *
 * `transferPointsCostThisGameweek` stands in for the repository's grouped transfer aggregate.
 * Omit it to model a team that made no transfers at all — the real query returns no row for such
 * a team, so the scorer has to treat the absence as zero.
 */
async function scoreSingleTeam(options: {
  captainPlayerId?: string | null;
  viceCaptainPlayerId?: string | null;
  rosterPlayerIds: string[];
  pointsByPlayerId: Record<string, number | undefined>;
  didNotAppearPlayerIds?: string[];
  transferPointsCostThisGameweek?: number;
}): Promise<TeamScore> {
  const team = buildTeam({
    id: "team1",
    captainPlayerId: options.captainPlayerId ?? null,
    viceCaptainPlayerId: options.viceCaptainPlayerId ?? null,
  });
  mocks.findAllTeams.mockResolvedValue([team]);
  if (options.transferPointsCostThisGameweek !== undefined) {
    mocks.sumTransferPointsCostByTeamForGameweek.mockResolvedValue([
      { teamId: team.id, transferPointsCost: options.transferPointsCostThisGameweek },
    ]);
  }
  mocks.findRosterSlots.mockResolvedValue(options.rosterPlayerIds.map((playerId) => ({ playerId, isStarting: true })));
  mocks.findPlayerGameweekPoints.mockImplementation(async (playerId: string) => {
    const points = options.pointsByPlayerId[playerId];
    if (points === undefined) return null;
    return playerGameweekPointsOf(points, !options.didNotAppearPlayerIds?.includes(playerId));
  });

  await calculateTeamScores(GAMEWEEK_ID);

  expect(mocks.replaceForGameweek).toHaveBeenCalledTimes(1);
  const [, scores] = mocks.replaceForGameweek.mock.calls[0]! as [string, TeamScore[]];
  expect(scores).toHaveLength(1);
  return scores[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nobody transferred this gameweek, so the grouped aggregate returns no rows at all.
  mocks.sumTransferPointsCostByTeamForGameweek.mockResolvedValue([]);
});

describe("calculateTeamScores — roster aggregation", () => {
  it("sums every roster player's points, including bench (no auto-subs in V1)", async () => {
    // Two players didn't play (null score) and count as 0; the rest sum directly.
    const score = await scoreSingleTeam({
      rosterPlayerIds: ["a", "b", "c", "d"],
      pointsByPlayerId: { a: 5, b: 3, c: undefined, d: 7 },
    });

    expect(score.totalPoints).toBe(15);
    expect(score.teamId).toBe("team1");
    expect(score.gameweekId).toBe(GAMEWEEK_ID);
  });
});

describe("calculateTeamScores — captain bonus", () => {
  it("adds the captain's points a second time when the captain played", async () => {
    const score = await scoreSingleTeam({
      captainPlayerId: "cap",
      viceCaptainPlayerId: "vice",
      rosterPlayerIds: ["cap", "vice", "x"],
      pointsByPlayerId: { cap: 10, vice: 4, x: 2 },
    });

    // base 10 + 4 + 2 = 16, plus captain bonus 10 = 26
    expect(score.totalPoints).toBe(26);
    expect(score.captainBonusPlayerId).toBe("cap");
  });

  it("falls back to the vice-captain when the captain did not play", async () => {
    const score = await scoreSingleTeam({
      captainPlayerId: "cap",
      viceCaptainPlayerId: "vice",
      rosterPlayerIds: ["cap", "vice", "x"],
      pointsByPlayerId: { cap: undefined, vice: 4, x: 2 },
    });

    // base 0 + 4 + 2 = 6, plus vice bonus 4 = 10
    expect(score.totalPoints).toBe(10);
    expect(score.captainBonusPlayerId).toBe("vice");
  });

  it("falls back to the vice-captain when the captain has a score row but didn't appear (0 minutes)", async () => {
    const score = await scoreSingleTeam({
      captainPlayerId: "cap",
      viceCaptainPlayerId: "vice",
      rosterPlayerIds: ["cap", "vice", "x"],
      pointsByPlayerId: { cap: 0, vice: 4, x: 2 },
      didNotAppearPlayerIds: ["cap"],
    });

    // base 0 + 4 + 2 = 6, plus vice bonus 4 = 10 (captain's 0 is worthless and must not double)
    expect(score.totalPoints).toBe(10);
    expect(score.captainBonusPlayerId).toBe("vice");
  });

  it("applies no bonus when neither captain nor vice played", async () => {
    const score = await scoreSingleTeam({
      captainPlayerId: "cap",
      viceCaptainPlayerId: "vice",
      rosterPlayerIds: ["cap", "vice", "x"],
      pointsByPlayerId: { cap: undefined, vice: undefined, x: 2 },
    });

    expect(score.totalPoints).toBe(2);
    expect(score.captainBonusPlayerId).toBeNull();
  });

  it("applies no bonus when no captain is set", async () => {
    const score = await scoreSingleTeam({
      captainPlayerId: null,
      viceCaptainPlayerId: null,
      rosterPlayerIds: ["x", "y"],
      pointsByPlayerId: { x: 3, y: 4 },
    });

    expect(score.totalPoints).toBe(7);
    expect(score.captainBonusPlayerId).toBeNull();
  });

  it("prefers the captain over the vice when both played", async () => {
    const score = await scoreSingleTeam({
      captainPlayerId: "cap",
      viceCaptainPlayerId: "vice",
      rosterPlayerIds: ["cap", "vice"],
      pointsByPlayerId: { cap: 8, vice: 9 },
    });

    // base 8 + 9 = 17, plus captain bonus 8 (not vice) = 25
    expect(score.totalPoints).toBe(25);
    expect(score.captainBonusPlayerId).toBe("cap");
  });
});

describe("calculateTeamScores — multiple teams", () => {
  it("produces one TeamScore per team", async () => {
    const teamA = buildTeam({ id: "A", captainPlayerId: "a1" });
    const teamB = buildTeam({ id: "B", captainPlayerId: "b1" });
    mocks.findAllTeams.mockResolvedValue([teamA, teamB]);
    mocks.findRosterSlots.mockImplementation(async (teamId: string) =>
      teamId === "A" ? [{ playerId: "a1", isStarting: true }] : [{ playerId: "b1", isStarting: true }],
    );
    mocks.findPlayerGameweekPoints.mockImplementation(async (playerId: string) =>
      playerGameweekPointsOf(playerId === "a1" ? 5 : 3),
    );

    await calculateTeamScores(GAMEWEEK_ID);

    const [, scores] = mocks.replaceForGameweek.mock.calls[0]! as [string, TeamScore[]];
    expect(scores).toHaveLength(2);
    const byTeam = new Map(scores.map((s) => [s.teamId, s.totalPoints]));
    expect(byTeam.get("A")).toBe(10); // 5 + captain bonus 5
    expect(byTeam.get("B")).toBe(6); // 3 + captain bonus 3
  });
});

describe("calculateTeamScores — paid transfer cost", () => {
  it("deducts 10 points for a single paid transfer", async () => {
    const score = await scoreSingleTeam({
      rosterPlayerIds: ["a", "b"],
      pointsByPlayerId: { a: 20, b: 5 },
      transferPointsCostThisGameweek: 10,
    });

    // base 20 + 5 = 25, less one paid transfer = 15
    expect(score.totalPoints).toBe(15);
    expect(score.transferPointsCost).toBe(10);
  });

  it("stacks the cost of several paid transfers in the same gameweek", async () => {
    const score = await scoreSingleTeam({
      rosterPlayerIds: ["a", "b"],
      pointsByPlayerId: { a: 40, b: 10 },
      transferPointsCostThisGameweek: 30,
    });

    // base 40 + 10 = 50, less three paid transfers = 20
    expect(score.totalPoints).toBe(20);
    expect(score.transferPointsCost).toBe(30);
  });

  it("deducts nothing when every transfer was covered by a banked free transfer", async () => {
    // Free transfers still produce Transfer rows, so the aggregate returns a row summing to 0.
    const score = await scoreSingleTeam({
      rosterPlayerIds: ["a", "b"],
      pointsByPlayerId: { a: 12, b: 6 },
      transferPointsCostThisGameweek: 0,
    });

    expect(score.totalPoints).toBe(18);
    expect(score.transferPointsCost).toBe(0);
  });

  it("leaves the total untouched and records zero when the team made no transfers", async () => {
    // No transferPointsCostThisGameweek at all: the team is absent from the grouped aggregate.
    const score = await scoreSingleTeam({
      rosterPlayerIds: ["a", "b"],
      pointsByPlayerId: { a: 12, b: 6 },
    });

    expect(score.totalPoints).toBe(18);
    expect(score.transferPointsCost).toBe(0);
  });

  it("applies both the captain bonus and the transfer cost", async () => {
    const score = await scoreSingleTeam({
      captainPlayerId: "cap",
      viceCaptainPlayerId: "vice",
      rosterPlayerIds: ["cap", "vice", "x"],
      pointsByPlayerId: { cap: 10, vice: 3, x: 2 },
      transferPointsCostThisGameweek: 20,
    });

    // base 10 + 3 + 2 = 15, plus captain bonus 10 = 25, less two paid transfers = 5.
    // Dropping either half would give 15 (no bonus) or 25 (no deduction) instead.
    expect(score.totalPoints).toBe(5);
    expect(score.transferPointsCost).toBe(20);
    expect(score.captainBonusPlayerId).toBe("cap");
  });

  it("lets the total go negative when transfer costs exceed the points scored", async () => {
    const score = await scoreSingleTeam({
      rosterPlayerIds: ["a", "b"],
      pointsByPlayerId: { a: 3, b: 1 },
      transferPointsCostThisGameweek: 30,
    });

    // base 3 + 1 = 4, less three paid transfers = -26. Nothing in the scoring engine clamps
    // at zero — red cards and own goals can push a score negative just as easily.
    expect(score.totalPoints).toBe(-26);
    expect(score.transferPointsCost).toBe(30);
  });

  it("charges each team only its own transfers, on one grouped read for the whole gameweek", async () => {
    const spendingTeam = buildTeam({ id: "spender", captainPlayerId: null, viceCaptainPlayerId: null });
    const thriftyTeam = buildTeam({ id: "thrifty", captainPlayerId: null, viceCaptainPlayerId: null });
    mocks.findAllTeams.mockResolvedValue([spendingTeam, thriftyTeam]);
    mocks.sumTransferPointsCostByTeamForGameweek.mockResolvedValue([{ teamId: "spender", transferPointsCost: 20 }]);
    mocks.findRosterSlots.mockImplementation(async (teamId: string) => [
      { playerId: teamId === "spender" ? "s1" : "t1", isStarting: true },
    ]);
    mocks.findPlayerGameweekPoints.mockImplementation(async () => playerGameweekPointsOf(30));

    await calculateTeamScores(GAMEWEEK_ID);

    const [, scores] = mocks.replaceForGameweek.mock.calls[0]! as [string, TeamScore[]];
    const byTeamId = new Map(scores.map((score) => [score.teamId, score]));
    expect(byTeamId.get("spender")!.totalPoints).toBe(10);
    expect(byTeamId.get("spender")!.transferPointsCost).toBe(20);
    expect(byTeamId.get("thrifty")!.totalPoints).toBe(30);
    expect(byTeamId.get("thrifty")!.transferPointsCost).toBe(0);
    // One read for every team, not one per team — the N+1 the architecture doc warns against.
    expect(mocks.sumTransferPointsCostByTeamForGameweek).toHaveBeenCalledTimes(1);
    expect(mocks.sumTransferPointsCostByTeamForGameweek).toHaveBeenCalledWith(GAMEWEEK_ID);
  });
});
