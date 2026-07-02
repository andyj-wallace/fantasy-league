import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerScore, TeamScore } from "../domain";
import { buildTeam } from "../testing/fixtures";

/**
 * Unit tests for the team-aggregation and captaincy rules in calculateTeamScores. Repositories are
 * mocked: we describe each team's roster and each player's gameweek score in-memory, then assert on
 * the TeamScore rows handed to teamScoresRepository.replaceForGameweek. Focus is the captain 2x
 * bonus and its fall back to the vice-captain, and that bench players count directly (no auto-subs).
 */
const GAMEWEEK_ID = "gw1";

const mocks = vi.hoisted(() => ({
  findAllTeams: vi.fn(),
  findRosterSlots: vi.fn(),
  findPlayerScore: vi.fn(),
  replaceForGameweek: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  teamsRepository: { findAll: mocks.findAllTeams, findRosterSlots: mocks.findRosterSlots },
  playerScoresRepository: { findByPlayerAndGameweek: mocks.findPlayerScore },
  teamScoresRepository: { replaceForGameweek: mocks.replaceForGameweek },
}));

import { calculateTeamScores } from "./calculateTeamScores";

/** Minimal PlayerScore stub carrying only the field calculateTeamScores reads. */
function playerScoreOf(totalPoints: number): PlayerScore {
  return { totalPoints } as PlayerScore;
}

/**
 * Sets up a single team whose roster is `rosterPlayerIds` (all starters unless noted) and whose
 * players have the given per-gameweek points, then runs the scorer and returns the one TeamScore.
 */
async function scoreSingleTeam(options: {
  captainPlayerId?: string | null;
  viceCaptainPlayerId?: string | null;
  rosterPlayerIds: string[];
  pointsByPlayerId: Record<string, number | undefined>;
}): Promise<TeamScore> {
  const team = buildTeam({
    id: "team1",
    captainPlayerId: options.captainPlayerId ?? null,
    viceCaptainPlayerId: options.viceCaptainPlayerId ?? null,
  });
  mocks.findAllTeams.mockResolvedValue([team]);
  mocks.findRosterSlots.mockResolvedValue(options.rosterPlayerIds.map((playerId) => ({ playerId, isStarting: true })));
  mocks.findPlayerScore.mockImplementation(async (playerId: string) => {
    const points = options.pointsByPlayerId[playerId];
    return points === undefined ? null : playerScoreOf(points);
  });

  await calculateTeamScores(GAMEWEEK_ID);

  expect(mocks.replaceForGameweek).toHaveBeenCalledTimes(1);
  const [, scores] = mocks.replaceForGameweek.mock.calls[0]! as [string, TeamScore[]];
  expect(scores).toHaveLength(1);
  return scores[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
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
    mocks.findPlayerScore.mockImplementation(async (playerId: string) =>
      playerScoreOf(playerId === "a1" ? 5 : 3),
    );

    await calculateTeamScores(GAMEWEEK_ID);

    const [, scores] = mocks.replaceForGameweek.mock.calls[0]! as [string, TeamScore[]];
    expect(scores).toHaveLength(2);
    const byTeam = new Map(scores.map((s) => [s.teamId, s.totalPoints]));
    expect(byTeam.get("A")).toBe(10); // 5 + captain bonus 5
    expect(byTeam.get("B")).toBe(6); // 3 + captain bonus 3
  });
});
