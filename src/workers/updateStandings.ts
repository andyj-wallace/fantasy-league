import { randomUUID } from "node:crypto";
import { db } from "../db/client";
import {
  gameweeksRepository,
  leagueStandingsRepository,
  playerMatchStatsRepository,
  teamScoresRepository,
  teamsRepository,
} from "../db/repositories";
import {
  roundToNearestTenthOfMillion,
  STARTING_SQUAD_BUDGET_IN_MILLIONS,
  rankTeamStandings,
  type LeagueStanding,
  type RankableTeamStanding,
} from "../domain";

/**
 * Recomputes one league's full leaderboard through the given gameweek. Runs as a single
 * REPEATABLE READ transaction: every team's points/roster/goals and its budget are read from one
 * consistent snapshot, so a transfer committing partway through can't make one team's
 * totalSpentInMillions tiebreaker stale relative to another's. The final write joins the same
 * transaction, so a run either lands wholly or not at all.
 */
export async function updateStandings(leagueId: string, gameweekId: string): Promise<void> {
  await db.transaction(
    async (tx) => {
      const gameweek = await gameweeksRepository.findById(gameweekId, tx);
      if (!gameweek) return;

      const teams = await teamsRepository.findByLeagueId(leagueId, tx);

      const rows: RankableTeamStanding[] = await Promise.all(
        teams.map(async (team) => {
          const totalPoints = await teamScoresRepository.sumTotalPointsThroughGameweek(team.id, gameweek.number, tx);
          const rosterSlots = await teamsRepository.findRosterSlots(team.id, tx);
          const goalsScoredBySelectedPlayers = await playerMatchStatsRepository.sumGoalsScoredThroughGameweek(
            rosterSlots.map((slot) => slot.playerId),
            gameweek.number,
            tx,
          );

          return {
            teamId: team.id,
            totalPoints,
            tiebreakerStats: {
              goalsScoredBySelectedPlayers,
              bankedFreeTransferCount: team.bankedFreeTransferCount,
              // Fresh subtraction, so it leaves the grid even though the budget arrived on it —
              // and this value is both compared for exact equality and persisted into jsonb.
              totalSpentInMillions: roundToNearestTenthOfMillion(
                STARTING_SQUAD_BUDGET_IN_MILLIONS - team.remainingBudgetInMillions,
              ),
            },
          };
        }),
      );

      const calculatedAt = new Date();
      const standings: LeagueStanding[] = rankTeamStandings(rows).map((row) => ({
        id: randomUUID(),
        leagueId,
        gameweekId,
        teamId: row.teamId,
        rank: row.rank,
        totalPoints: row.totalPoints,
        tiebreakerStats: row.tiebreakerStats,
        calculatedAt,
      }));

      await leagueStandingsRepository.replaceForGameweek(leagueId, gameweekId, standings, tx);
    },
    { isolationLevel: "repeatable read" },
  );
}
