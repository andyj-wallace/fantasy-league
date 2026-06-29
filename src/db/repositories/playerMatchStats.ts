import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "../client";
import { gameweeks, matches, playerMatchStats } from "../schema";
import type { PlayerMatchStat } from "../../domain";

function toPlayerMatchStat(row: typeof playerMatchStats.$inferSelect): PlayerMatchStat {
  return {
    id: row.id,
    matchId: row.matchId,
    playerId: row.playerId,
    minutesPlayed: row.minutesPlayed,
    goalsScored: row.goalsScored,
    assists: row.assists,
    savesCount: row.savesCount,
    ownGoalsScored: row.ownGoalsScored,
    penaltiesWon: row.penaltiesWon,
    penaltiesConceded: row.penaltiesConceded,
    receivedYellowCard: row.receivedYellowCard,
    receivedRedCard: row.receivedRedCard,
  };
}

export async function findByMatchId(matchId: string): Promise<PlayerMatchStat[]> {
  const rows = await db.select().from(playerMatchStats).where(eq(playerMatchStats.matchId, matchId));
  return rows.map(toPlayerMatchStat);
}

export async function insertMany(stats: PlayerMatchStat[]): Promise<void> {
  if (stats.length === 0) return;
  await db.insert(playerMatchStats).values(
    stats.map((stat) => ({
      id: stat.id,
      matchId: stat.matchId,
      playerId: stat.playerId,
      minutesPlayed: stat.minutesPlayed,
      goalsScored: stat.goalsScored,
      assists: stat.assists,
      savesCount: stat.savesCount,
      ownGoalsScored: stat.ownGoalsScored,
      penaltiesWon: stat.penaltiesWon,
      penaltiesConceded: stat.penaltiesConceded,
      receivedYellowCard: stat.receivedYellowCard,
      receivedRedCard: stat.receivedRedCard,
    })),
  );
}

/** Replaces every PlayerMatchStat row for a Match — used by the confirmation pass to overwrite
 * provisional stats with corrected ones (e.g. late VAR review) without duplicating rows. */
export async function replaceForMatch(matchId: string, stats: PlayerMatchStat[]): Promise<void> {
  await db.delete(playerMatchStats).where(eq(playerMatchStats.matchId, matchId));
  await insertMany(stats);
}

/** Powers the "goals scored by selected players" standings tiebreaker — sums goals across every
 * Match up to and including the given gameweek for the given (roster) player IDs. */
export async function sumGoalsScoredThroughGameweek(
  playerIds: string[],
  gameweekNumber: number,
): Promise<number> {
  if (playerIds.length === 0) return 0;
  const rows = await db
    .select({ goalsScored: playerMatchStats.goalsScored })
    .from(playerMatchStats)
    .innerJoin(matches, eq(playerMatchStats.matchId, matches.id))
    .innerJoin(gameweeks, eq(matches.gameweekId, gameweeks.id))
    .where(and(inArray(playerMatchStats.playerId, playerIds), lte(gameweeks.number, gameweekNumber)));
  return rows.reduce((sum, row) => sum + row.goalsScored, 0);
}
