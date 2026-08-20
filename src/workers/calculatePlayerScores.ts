import { randomUUID } from "node:crypto";
import {
  matchesRepository,
  matchGoalEventsRepository,
  playerMatchStatsRepository,
  playerScoresRepository,
  playersRepository,
} from "../db/repositories";
import { calculateGameStateBonusPoints, GOAL_POINTS_BY_POSITION, identifyDecisiveGoals } from "../domain";
import type { Match, MatchGoalEvent, Player, PlayerMatchStat, PlayerScore, PlayerScoreBreakdown } from "../domain";

/**
 * Resolves every player's game-state bonus/penalty for one Match into a playerId -> points map.
 * Recipients are a union, never a sum: a starting defender who scored the decisive own goal is
 * penalized once, per fantasy_league_v1_design.txt.
 */
function applyGameStateBonus(
  match: Match,
  goalEvents: MatchGoalEvent[],
  stats: PlayerMatchStat[],
  playersById: Map<string, Player>,
): Map<string, number> {
  const bonusPointsByPlayerId = new Map<string, number>();
  const { winningGoal, equalizingGoal, losingGoal } = identifyDecisiveGoals(goalEvents, match);

  const rewardedGoal = winningGoal ?? equalizingGoal;
  // An own goal cannot win or level a match for the side it benefits, so nobody is rewarded
  // for one — but its scorer is still penalized below, via losingGoal.
  if (rewardedGoal && rewardedGoal.goalType !== "OWN_GOAL") {
    const bonusPoints = calculateGameStateBonusPoints(rewardedGoal, "BONUS");
    for (const recipientId of [rewardedGoal.scorerPlayerId, rewardedGoal.assistPlayerId]) {
      if (recipientId) bonusPointsByPlayerId.set(recipientId, bonusPoints);
    }
  }

  if (losingGoal) {
    const penaltyPoints = calculateGameStateBonusPoints(losingGoal, "PENALTY");
    const concedingClub = losingGoal.beneficiaryClub === match.homeClub ? match.awayClub : match.homeClub;

    for (const stat of stats) {
      const player = playersById.get(stat.playerId);
      if (!player || player.club !== concedingClub) continue;
      const isPenalizedPosition = player.position === "GK" || player.position === "DEF";
      if (stat.wasInStartingLineup && isPenalizedPosition) bonusPointsByPlayerId.set(stat.playerId, penaltyPoints);
    }

    if (losingGoal.goalType === "OWN_GOAL" && losingGoal.scorerPlayerId) {
      bonusPointsByPlayerId.set(losingGoal.scorerPlayerId, penaltyPoints);
    }
  }

  return bonusPointsByPlayerId;
}

/** Turns a Match's raw PlayerMatchStat rows into precomputed PlayerScore rows, per the point
 * table in fantasy_league_v1_design.txt. */
export async function calculatePlayerScores(matchId: string): Promise<void> {
  const match = await matchesRepository.findById(matchId);
  if (!match) return;

  const stats = await playerMatchStatsRepository.findByMatchId(matchId);
  const players = await playersRepository.findManyByIds(stats.map((stat) => stat.playerId));
  const playersById = new Map(players.map((player) => [player.id, player]));

  const goalEvents = await matchGoalEventsRepository.findByMatchId(matchId);
  const gameStateBonusPointsByPlayerId = applyGameStateBonus(match, goalEvents, stats, playersById);

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
      yellowCardPoints: stat.receivedYellowCard ? -1 : 0,
      redCardPoints: stat.receivedRedCard ? -2 : 0,
      ownGoalPoints: stat.ownGoalsScored * -2,
      penaltyConcededPoints: stat.penaltiesConceded * -1,
      gameStateBonusPoints: gameStateBonusPointsByPlayerId.get(stat.playerId) ?? 0,
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
