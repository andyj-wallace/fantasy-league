import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Match, MatchGoalEvent, Player, PlayerMatchStat, PlayerScore } from "../domain";
import { buildMatch, buildMatchGoalEvent, buildPlayer, buildPlayerMatchStat } from "../testing/fixtures";

/**
 * Unit tests for the per-player scoring rules in fantasy_league_v1_design.txt. The repository
 * barrel is mocked so these run with no database: we feed in a Match + Player + PlayerMatchStat
 * and assert on the PlayerScore rows handed to playerScoresRepository.replaceForMatch.
 */
const mocks = vi.hoisted(() => ({
  findMatchById: vi.fn(),
  findStatsByMatchId: vi.fn(),
  findPlayersByIds: vi.fn(),
  findGoalEventsByMatchId: vi.fn(),
  replaceForMatch: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  matchesRepository: { findById: mocks.findMatchById },
  playerMatchStatsRepository: { findByMatchId: mocks.findStatsByMatchId },
  playersRepository: { findManyByIds: mocks.findPlayersByIds },
  matchGoalEventsRepository: { findByMatchId: mocks.findGoalEventsByMatchId },
  playerScoresRepository: { replaceForMatch: mocks.replaceForMatch },
}));

import { calculatePlayerScores } from "./calculatePlayerScores";

/** Runs the scorer over a whole match and returns every produced PlayerScore, in stat order.
 * The game-state rules need several players in one match (a conceding club's whole back line),
 * which is why this exists alongside the single-player scoreOne. */
async function scoreAll(
  players: Player[],
  stats: PlayerMatchStat[],
  match: Match,
  goalEvents: MatchGoalEvent[] = [],
): Promise<PlayerScore[]> {
  mocks.replaceForMatch.mockClear(); // idempotent within a test that scores several times
  mocks.findMatchById.mockResolvedValue(match);
  mocks.findStatsByMatchId.mockResolvedValue(stats);
  mocks.findPlayersByIds.mockResolvedValue(players);
  mocks.findGoalEventsByMatchId.mockResolvedValue(goalEvents);

  await calculatePlayerScores(match.id);

  expect(mocks.replaceForMatch).toHaveBeenCalledTimes(1);
  const [, scores] = mocks.replaceForMatch.mock.calls[0]! as [string, PlayerScore[]];
  return scores;
}

/** Runs the scorer for a single player/stat pairing and returns the one produced PlayerScore. */
async function scoreOne(player: Player, stat: PlayerMatchStat, match: Match): Promise<PlayerScore> {
  const scores = await scoreAll([player], [stat], match);
  expect(scores).toHaveLength(1);
  return scores[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every pre-existing test predates the game-state bonus and expects an empty timeline.
  mocks.findGoalEventsByMatchId.mockResolvedValue([]);
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

/**
 * The game-state bonus layer (fantasy_league_v1_design.txt, "Bonus Points — Game State Goals").
 * Match defaults are Home FC vs Away FC, so every player here sets `club` explicitly — the
 * losing-goal penalty is scoped by club, and buildPlayer's default club is in neither.
 */
describe("calculatePlayerScores — game-state goal bonus", () => {
  const HOME_CLUB = "Home FC";
  const AWAY_CLUB = "Away FC";

  /** Each timing bracket, keyed by a minute inside it, with the bonus that minute should earn. */
  const bonusPointsByMinute = [
    { elapsedMinute: 30, expectedBonusPoints: 5 },
    { elapsedMinute: 78, expectedBonusPoints: 6 },
    { elapsedMinute: 83, expectedBonusPoints: 8 },
    { elapsedMinute: 88, expectedBonusPoints: 10 },
    { elapsedMinute: 95, expectedBonusPoints: 13 },
  ];

  describe("winning goal", () => {
    for (const { elapsedMinute, expectedBonusPoints } of bonusPointsByMinute) {
      it(`gives the scorer and assister ${expectedBonusPoints} points for a winner in minute ${elapsedMinute}`, async () => {
        const match = buildMatch({ id: "m1", finalHomeScore: 1, finalAwayScore: 0 });
        const scorer = buildPlayer({ id: "scorer", club: HOME_CLUB, position: "FWD" });
        const assister = buildPlayer({ id: "assister", club: HOME_CLUB, position: "MID" });

        const scores = await scoreAll(
          [scorer, assister],
          [
            buildPlayerMatchStat({ playerId: "scorer", matchId: "m1", goalsScored: 1 }),
            buildPlayerMatchStat({ playerId: "assister", matchId: "m1", assists: 1 }),
          ],
          match,
          [
            buildMatchGoalEvent({
              matchId: "m1",
              beneficiaryClub: HOME_CLUB,
              scorerPlayerId: "scorer",
              assistPlayerId: "assister",
              elapsedMinute,
            }),
          ],
        );

        expect(scores[0]!.breakdown.gameStateBonusPoints).toBe(expectedBonusPoints);
        expect(scores[1]!.breakdown.gameStateBonusPoints).toBe(expectedBonusPoints);
      });
    }
  });

  describe("equalizing goal", () => {
    for (const { elapsedMinute, expectedBonusPoints } of bonusPointsByMinute) {
      it(`gives the scorer and assister ${expectedBonusPoints} points for the final equalizer in minute ${elapsedMinute}`, async () => {
        const match = buildMatch({ id: "m1", finalHomeScore: 1, finalAwayScore: 1 });
        const scorer = buildPlayer({ id: "scorer", club: AWAY_CLUB, position: "FWD" });
        const assister = buildPlayer({ id: "assister", club: AWAY_CLUB, position: "MID" });

        const scores = await scoreAll(
          [scorer, assister],
          [
            buildPlayerMatchStat({ playerId: "scorer", matchId: "m1", goalsScored: 1 }),
            buildPlayerMatchStat({ playerId: "assister", matchId: "m1", assists: 1 }),
          ],
          match,
          [
            buildMatchGoalEvent({ matchId: "m1", beneficiaryClub: HOME_CLUB, elapsedMinute: 10, sequenceIndex: 0 }),
            buildMatchGoalEvent({
              matchId: "m1",
              beneficiaryClub: AWAY_CLUB,
              scorerPlayerId: "scorer",
              assistPlayerId: "assister",
              elapsedMinute,
              sequenceIndex: 1,
            }),
          ],
        );

        expect(scores[0]!.breakdown.gameStateBonusPoints).toBe(expectedBonusPoints);
        expect(scores[1]!.breakdown.gameStateBonusPoints).toBe(expectedBonusPoints);
      });
    }
  });

  describe("losing goal", () => {
    /** Home FC wins 1-0; every assertion below is about who on Away FC pays for it. */
    async function scoreConcedingSquad(elapsedMinute: number): Promise<PlayerScore[]> {
      const match = buildMatch({ id: "m1", finalHomeScore: 1, finalAwayScore: 0 });
      const players = [
        buildPlayer({ id: "conceding-gk", club: AWAY_CLUB, position: "GK" }),
        buildPlayer({ id: "conceding-def", club: AWAY_CLUB, position: "DEF" }),
        buildPlayer({ id: "benched-def", club: AWAY_CLUB, position: "DEF" }),
        buildPlayer({ id: "conceding-mid", club: AWAY_CLUB, position: "MID" }),
        buildPlayer({ id: "winning-gk", club: HOME_CLUB, position: "GK" }),
      ];
      const stats = [
        buildPlayerMatchStat({ playerId: "conceding-gk", matchId: "m1" }),
        buildPlayerMatchStat({ playerId: "conceding-def", matchId: "m1" }),
        buildPlayerMatchStat({ playerId: "benched-def", matchId: "m1", wasInStartingLineup: false }),
        buildPlayerMatchStat({ playerId: "conceding-mid", matchId: "m1" }),
        buildPlayerMatchStat({ playerId: "winning-gk", matchId: "m1" }),
      ];
      return scoreAll(players, stats, match, [
        buildMatchGoalEvent({ matchId: "m1", beneficiaryClub: HOME_CLUB, scorerPlayerId: "someone-else", elapsedMinute }),
      ]);
    }

    for (const { elapsedMinute, expectedBonusPoints } of bonusPointsByMinute) {
      it(`charges the conceding club's starting GK and DEF ${-expectedBonusPoints} for a loser in minute ${elapsedMinute}`, async () => {
        const scores = await scoreConcedingSquad(elapsedMinute);

        expect(scores[0]!.breakdown.gameStateBonusPoints).toBe(-expectedBonusPoints);
        expect(scores[1]!.breakdown.gameStateBonusPoints).toBe(-expectedBonusPoints);
      });
    }

    it("does not charge a benched GK/DEF, an outfield MID, or the winning club's own keeper", async () => {
      const scores = await scoreConcedingSquad(30);

      expect(scores[2]!.breakdown.gameStateBonusPoints).toBe(0); // benched DEF
      expect(scores[3]!.breakdown.gameStateBonusPoints).toBe(0); // conceding MID
      expect(scores[4]!.breakdown.gameStateBonusPoints).toBe(0); // winning club's GK
    });
  });

  describe("own goals", () => {
    it("charges a decisive own-goal scorer and rewards nobody, not even the credited assister", async () => {
      const match = buildMatch({ id: "m1", finalHomeScore: 1, finalAwayScore: 0 });
      const ownGoalScorer = buildPlayer({ id: "og-scorer", club: AWAY_CLUB, position: "MID" });
      const wouldBeAssister = buildPlayer({ id: "assister", club: HOME_CLUB, position: "MID" });

      const scores = await scoreAll(
        [ownGoalScorer, wouldBeAssister],
        [
          buildPlayerMatchStat({ playerId: "og-scorer", matchId: "m1", ownGoalsScored: 1 }),
          buildPlayerMatchStat({ playerId: "assister", matchId: "m1" }),
        ],
        match,
        [
          buildMatchGoalEvent({
            matchId: "m1",
            beneficiaryClub: HOME_CLUB,
            goalType: "OWN_GOAL",
            scorerPlayerId: "og-scorer",
            assistPlayerId: "assister",
            elapsedMinute: 30,
          }),
        ],
      );

      expect(scores[0]!.breakdown.gameStateBonusPoints).toBe(-5);
      expect(scores[1]!.breakdown.gameStateBonusPoints).toBe(0);
    });

    it("neither rewards nor penalizes an equalizing own goal, since a draw has no losing side", async () => {
      const match = buildMatch({ id: "m1", finalHomeScore: 1, finalAwayScore: 1 });
      const ownGoalScorer = buildPlayer({ id: "og-scorer", club: AWAY_CLUB, position: "DEF" });

      const scores = await scoreAll(
        [ownGoalScorer],
        [buildPlayerMatchStat({ playerId: "og-scorer", matchId: "m1", ownGoalsScored: 1 })],
        match,
        [
          buildMatchGoalEvent({ matchId: "m1", beneficiaryClub: AWAY_CLUB, elapsedMinute: 10, sequenceIndex: 0 }),
          buildMatchGoalEvent({
            matchId: "m1",
            beneficiaryClub: HOME_CLUB,
            goalType: "OWN_GOAL",
            scorerPlayerId: "og-scorer",
            elapsedMinute: 88,
            sequenceIndex: 1,
          }),
        ],
      );

      expect(scores[0]!.breakdown.gameStateBonusPoints).toBe(0);
    });

    it("charges a starting DEF who scored the decisive own goal exactly once, not twice", async () => {
      const match = buildMatch({ id: "m1", finalHomeScore: 1, finalAwayScore: 0 });
      const ownGoalDefender = buildPlayer({ id: "og-def", club: AWAY_CLUB, position: "DEF" });

      const scores = await scoreAll(
        [ownGoalDefender],
        [buildPlayerMatchStat({ playerId: "og-def", matchId: "m1", ownGoalsScored: 1 })],
        match,
        [
          buildMatchGoalEvent({
            matchId: "m1",
            beneficiaryClub: HOME_CLUB,
            goalType: "OWN_GOAL",
            scorerPlayerId: "og-def",
            elapsedMinute: 88,
          }),
        ],
      );

      expect(scores[0]!.breakdown.gameStateBonusPoints).toBe(-10);
    });
  });

  it("adds the bonus into totalPoints on top of the base event points", async () => {
    const match = buildMatch({ id: "m1", finalHomeScore: 1, finalAwayScore: 0 });
    const scorer = buildPlayer({ id: "scorer", club: HOME_CLUB, position: "FWD" });

    const scores = await scoreAll(
      [scorer],
      [buildPlayerMatchStat({ playerId: "scorer", matchId: "m1", goalsScored: 1 })],
      match,
      [buildMatchGoalEvent({ matchId: "m1", beneficiaryClub: HOME_CLUB, scorerPlayerId: "scorer", elapsedMinute: 30 })],
    );

    // 1 appearance + 4 for a FWD goal + 5 game-state bonus
    expect(scores[0]!.totalPoints).toBe(10);
  });
});
