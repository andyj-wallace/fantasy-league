import { randomUUID } from "node:crypto";
import { db } from "../db/client";
import {
  gameweeksRepository,
  leagueStandingsRepository,
  playerMatchStatsRepository,
  teamScoresRepository,
  teamsRepository,
} from "../db/repositories";
import { STARTING_SQUAD_BUDGET_IN_MILLIONS, type LeagueStanding, type LeagueStandingTiebreakerStats } from "../domain";

interface StandingRow {
  teamId: string;
  totalPoints: number;
  tiebreakerStats: LeagueStandingTiebreakerStats;
}

/** Tiebreaker order from fantasy_league_v1_design.txt: goals scored, then banked transfers, then
 * least spent. Equal on all four (including totalPoints) means a shared rank. */
function compareStandingRows(a: StandingRow, b: StandingRow): number {
  return (
    b.totalPoints - a.totalPoints ||
    b.tiebreakerStats.goalsScoredBySelectedPlayers - a.tiebreakerStats.goalsScoredBySelectedPlayers ||
    b.tiebreakerStats.bankedFreeTransferCount - a.tiebreakerStats.bankedFreeTransferCount ||
    a.tiebreakerStats.totalSpentInMillions - b.tiebreakerStats.totalSpentInMillions
  );
}

function isFullTie(a: StandingRow, b: StandingRow): boolean {
  return compareStandingRows(a, b) === 0;
}

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

      const rows: StandingRow[] = await Promise.all(
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
              totalSpentInMillions: STARTING_SQUAD_BUDGET_IN_MILLIONS - team.remainingBudgetInMillions,
            },
          };
        }),
      );

      rows.sort(compareStandingRows);

      const standings: LeagueStanding[] = [];
      let rank = 0;
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        const isTiedWithPrevious = index > 0 && isFullTie(rows[index - 1]!, row);
        if (!isTiedWithPrevious) rank = index + 1;

        standings.push({
          id: randomUUID(),
          leagueId,
          gameweekId,
          teamId: row.teamId,
          rank,
          totalPoints: row.totalPoints,
          tiebreakerStats: row.tiebreakerStats,
          calculatedAt: new Date(),
        });
      }

      await leagueStandingsRepository.replaceForGameweek(leagueId, gameweekId, standings, tx);
    },
    { isolationLevel: "repeatable read" },
  );
}
