import { randomUUID } from "node:crypto";
import { matchesRepository, playerMatchStatsRepository, playerScoresRepository, playersRepository } from "../db/repositories";
import type { PlayerPosition, PlayerScore, PlayerScoreBreakdown } from "../domain";

/** Points per goal, by scorer position — fantasy_league_v1_design.txt. */
const GOAL_POINTS_BY_POSITION: Record<PlayerPosition, number> = { GK: 10, DEF: 8, MID: 6, FWD: 4 };

/** Turns a Match's raw PlayerMatchStat rows into precomputed PlayerScore rows, per the point
 * table in fantasy_league_v1_design.txt. */
export async function calculatePlayerScores(matchId: string): Promise<void> {
  const match = await matchesRepository.findById(matchId);
  if (!match) return;

  const stats = await playerMatchStatsRepository.findByMatchId(matchId);
  const players = await playersRepository.findManyByIds(stats.map((stat) => stat.playerId));
  const playersById = new Map(players.map((player) => [player.id, player]));

  const scores: PlayerScore[] = [];
  for (const stat of stats) {
    const player = playersById.get(stat.playerId);
    if (!player) continue; // shouldn't happen for real data; nothing to score against

    const didAppear = stat.minutesPlayed > 0;
    const isCleanSheetEligiblePosition = player.position === "GK" || player.position === "DEF";
    const opponentScored0 =
      (player.club === match.homeClub && match.finalAwayScore === 0) ||
      (player.club === match.awayClub && match.finalHomeScore === 0);

    const breakdown: PlayerScoreBreakdown = {
      appearancePoints: didAppear ? 1 : 0,
      goalPoints: stat.goalsScored * GOAL_POINTS_BY_POSITION[player.position],
      assistPoints: stat.assists * 3,
      cleanSheetPoints: didAppear && isCleanSheetEligiblePosition && opponentScored0 ? 4 : 0,
      savePoints: Math.floor(stat.savesCount / 3),
      penaltyWonPoints: stat.penaltiesWon * 2,
      directFreeKickGoalBonusPoints: stat.directFreeKickGoalsScored * 1,
      yellowCardPoints: stat.receivedYellowCard ? -1 : 0,
      redCardPoints: stat.receivedRedCard ? -2 : 0,
      ownGoalPoints: stat.ownGoalsScored * -2,
      penaltyConcededPoints: stat.penaltiesConceded * -1,
    };

    const totalPoints = Object.values(breakdown).reduce((sum, points) => sum + points, 0);

    scores.push({
      id: randomUUID(),
      playerId: stat.playerId,
      matchId,
      gameweekId: match.gameweekId,
      breakdown,
      totalPoints,
      calculatedAt: new Date(),
    });
  }

  await playerScoresRepository.replaceForMatch(matchId, scores);
}
