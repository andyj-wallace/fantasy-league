import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Match, Player, PlayerMatchStat, PlayerScore } from "../domain";
import { buildMatch, buildPlayer, buildPlayerMatchStat } from "../testing/fixtures";

/**
 * Unit tests for the per-player scoring rules in fantasy_league_v1_design.txt. The repository
 * barrel is mocked so these run with no database: we feed in a Match + Player + PlayerMatchStat
 * and assert on the PlayerScore rows handed to playerScoresRepository.replaceForMatch.
 */
const mocks = vi.hoisted(() => ({
  findMatchById: vi.fn(),
  findStatsByMatchId: vi.fn(),
  findPlayersByIds: vi.fn(),
  replaceForMatch: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  matchesRepository: { findById: mocks.findMatchById },
  playerMatchStatsRepository: { findByMatchId: mocks.findStatsByMatchId },
  playersRepository: { findManyByIds: mocks.findPlayersByIds },
  playerScoresRepository: { replaceForMatch: mocks.replaceForMatch },
}));

import { calculatePlayerScores } from "./calculatePlayerScores";

/** Runs the scorer for a single player/stat pairing and returns the one produced PlayerScore. */
async function scoreOne(player: Player, stat: PlayerMatchStat, match: Match): Promise<PlayerScore> {
  mocks.replaceForMatch.mockClear(); // idempotent within a test that scores several players
  mocks.findMatchById.mockResolvedValue(match);
  mocks.findStatsByMatchId.mockResolvedValue([stat]);
  mocks.findPlayersByIds.mockResolvedValue([player]);

  await calculatePlayerScores(match.id);

  expect(mocks.replaceForMatch).toHaveBeenCalledTimes(1);
  const [, scores] = mocks.replaceForMatch.mock.calls[0]! as [string, PlayerScore[]];
  expect(scores).toHaveLength(1);
  return scores[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("calculatePlayerScores — appearance", () => {
  it("awards 1 appearance point when the player played any minutes", async () => {
    const player = buildPlayer({ id: "p1" });
    const match = buildMatch({ id: "m1", gameweekId: "gw1" });
    const stat = buildPlayerMatchStat({ playerId: "p1", matchId: "m1", minutesPlayed: 12 });

    const score = await scoreOne(player, stat, match);

    expect(score.breakdown.appearancePoints).toBe(1);
    expect(score.playerId).toBe("p1");
    expect(score.gameweekId).toBe("gw1");
  });

  it("awards no appearance point for 0 minutes", async () => {
    const player = buildPlayer({ id: "p1" });
    const match = buildMatch({ id: "m1" });
    const stat = buildPlayerMatchStat({ playerId: "p1", matchId: "m1", minutesPlayed: 0 });

    const score = await scoreOne(player, stat, match);

    expect(score.breakdown.appearancePoints).toBe(0);
  });
});

describe("calculatePlayerScores — goals by position", () => {
  const goalPointsByPosition = { GK: 10, DEF: 8, MID: 6, FWD: 4 } as const;

  for (const [position, expectedPerGoal] of Object.entries(goalPointsByPosition)) {
    it(`gives a ${position} ${expectedPerGoal} points per goal`, async () => {
      const player = buildPlayer({ id: "p1", position: position as keyof typeof goalPointsByPosition });
      const match = buildMatch({ id: "m1" });
      const stat = buildPlayerMatchStat({ playerId: "p1", matchId: "m1", goalsScored: 2 });

      const score = await scoreOne(player, stat, match);

      expect(score.breakdown.goalPoints).toBe(expectedPerGoal * 2);
    });
  }
});

describe("calculatePlayerScores — assists, saves, penalties, cards", () => {
  it("gives 3 points per assist", async () => {
    const score = await scoreOne(
      buildPlayer({ id: "p1" }),
      buildPlayerMatchStat({ playerId: "p1", matchId: "m1", assists: 2 }),
      buildMatch({ id: "m1" }),
    );
    expect(score.breakdown.assistPoints).toBe(6);
  });

  it("gives 1 save point per 3 saves, rounded down", async () => {
    const score = await scoreOne(
      buildPlayer({ id: "p1", position: "GK" }),
      buildPlayerMatchStat({ playerId: "p1", matchId: "m1", savesCount: 7 }),
      buildMatch({ id: "m1" }),
    );
    expect(score.breakdown.savePoints).toBe(2); // floor(7 / 3)
  });

  it("gives 2 points per penalty won", async () => {
    const score = await scoreOne(
      buildPlayer({ id: "p1" }),
      buildPlayerMatchStat({ playerId: "p1", matchId: "m1", penaltiesWon: 1 }),
      buildMatch({ id: "m1" }),
    );
    expect(score.breakdown.penaltyWonPoints).toBe(2);
  });

  it("deducts for yellow (-1), red (-2), own goals (-2 each), penalties conceded (-1 each)", async () => {
    const score = await scoreOne(
      buildPlayer({ id: "p1" }),
      buildPlayerMatchStat({
        playerId: "p1",
        matchId: "m1",
        receivedYellowCard: true,
        receivedRedCard: true,
        ownGoalsScored: 2,
        penaltiesConceded: 3,
      }),
      buildMatch({ id: "m1" }),
    );
    expect(score.breakdown.yellowCardPoints).toBe(-1);
    expect(score.breakdown.redCardPoints).toBe(-2);
    expect(score.breakdown.ownGoalPoints).toBe(-4);
    expect(score.breakdown.penaltyConcededPoints).toBe(-3);
  });
});

describe("calculatePlayerScores — clean sheet", () => {
  it("gives a GK who played 4 points when the opponent scored 0 (home)", async () => {
    const player = buildPlayer({ id: "p1", position: "GK", club: "Home FC" });
    const match = buildMatch({ id: "m1", homeClub: "Home FC", awayClub: "Away FC", finalAwayScore: 0 });
    const stat = buildPlayerMatchStat({ playerId: "p1", matchId: "m1" });

    const score = await scoreOne(player, stat, match);

    expect(score.breakdown.cleanSheetPoints).toBe(4);
  });

  it("gives a DEF who played 4 points when the opponent scored 0 (away)", async () => {
    const player = buildPlayer({ id: "p1", position: "DEF", club: "Away FC" });
    const match = buildMatch({ id: "m1", homeClub: "Home FC", awayClub: "Away FC", finalHomeScore: 0 });
    const stat = buildPlayerMatchStat({ playerId: "p1", matchId: "m1" });

    const score = await scoreOne(player, stat, match);

    expect(score.breakdown.cleanSheetPoints).toBe(4);
  });

  it("gives no clean sheet to MID or FWD even when the opponent scored 0", async () => {
    const match = buildMatch({ id: "m1", homeClub: "Home FC", awayClub: "Away FC", finalAwayScore: 0 });

    const midScore = await scoreOne(
      buildPlayer({ id: "mid", position: "MID", club: "Home FC" }),
      buildPlayerMatchStat({ playerId: "mid", matchId: "m1" }),
      match,
    );
    const fwdScore = await scoreOne(
      buildPlayer({ id: "fwd", position: "FWD", club: "Home FC" }),
      buildPlayerMatchStat({ playerId: "fwd", matchId: "m1" }),
      match,
    );

    expect(midScore.breakdown.cleanSheetPoints).toBe(0);
    expect(fwdScore.breakdown.cleanSheetPoints).toBe(0);
  });

  it("gives no clean sheet when the opponent scored", async () => {
    const player = buildPlayer({ id: "p1", position: "GK", club: "Home FC" });
    const match = buildMatch({ id: "m1", homeClub: "Home FC", awayClub: "Away FC", finalAwayScore: 1 });
    const stat = buildPlayerMatchStat({ playerId: "p1", matchId: "m1" });

    const score = await scoreOne(player, stat, match);

    expect(score.breakdown.cleanSheetPoints).toBe(0);
  });

  it("gives no clean sheet to an eligible player who did not appear", async () => {
    const player = buildPlayer({ id: "p1", position: "DEF", club: "Home FC" });
    const match = buildMatch({ id: "m1", homeClub: "Home FC", awayClub: "Away FC", finalAwayScore: 0 });
    const stat = buildPlayerMatchStat({ playerId: "p1", matchId: "m1", minutesPlayed: 0 });

    const score = await scoreOne(player, stat, match);

    expect(score.breakdown.cleanSheetPoints).toBe(0);
    expect(score.breakdown.appearancePoints).toBe(0);
  });
});

describe("calculatePlayerScores — total and edge cases", () => {
  it("sums the breakdown into totalPoints", async () => {
    // GK, appeared (1), 1 goal (10), 1 assist (3), clean sheet (4), 6 saves (2), yellow (-1) = 19
    const player = buildPlayer({ id: "p1", position: "GK", club: "Home FC" });
    const match = buildMatch({ id: "m1", homeClub: "Home FC", awayClub: "Away FC", finalAwayScore: 0 });
    const stat = buildPlayerMatchStat({
      playerId: "p1",
      matchId: "m1",
      goalsScored: 1,
      assists: 1,
      savesCount: 6,
      receivedYellowCard: true,
    });

    const score = await scoreOne(player, stat, match);

    expect(score.totalPoints).toBe(19);
  });

  it("does nothing when the match is not found", async () => {
    mocks.findMatchById.mockResolvedValue(undefined);

    await calculatePlayerScores("missing");

    expect(mocks.replaceForMatch).not.toHaveBeenCalled();
  });

  it("skips stat rows whose player is missing rather than throwing", async () => {
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: "m1" }));
    mocks.findStatsByMatchId.mockResolvedValue([buildPlayerMatchStat({ playerId: "ghost", matchId: "m1" })]);
    mocks.findPlayersByIds.mockResolvedValue([]);

    await calculatePlayerScores("m1");

    const [, scores] = mocks.replaceForMatch.mock.calls[0]! as [string, PlayerScore[]];
    expect(scores).toHaveLength(0);
  });
});
