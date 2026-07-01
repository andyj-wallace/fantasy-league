import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../client";
import { gameweeks, playerScores } from "../schema";
import type { PlayerScore, PlayerScoreBreakdown } from "../../domain";

function toPlayerScore(row: typeof playerScores.$inferSelect): PlayerScore {
  return {
    id: row.id,
    playerId: row.playerId,
    matchId: row.matchId,
    gameweekId: row.gameweekId,
    breakdown: row.breakdown as PlayerScoreBreakdown,
    totalPoints: row.totalPoints,
    calculatedAt: row.calculatedAt,
  };
}

export async function findByPlayerAndGameweek(
  playerId: string,
  gameweekId: string,
): Promise<PlayerScore | null> {
  const [row] = await db
    .select()
    .from(playerScores)
    .where(and(eq(playerScores.playerId, playerId), eq(playerScores.gameweekId, gameweekId)));
  return row ? toPlayerScore(row) : null;
}

/** Every scored match's points for the given players, newest gameweek first — the shape squad-
 * builder player cards need for total points and recent form, without the full breakdown. */
export async function findManyByPlayerIds(
  playerIds: string[],
): Promise<{ playerId: string; gameweekNumber: number; totalPoints: number }[]> {
  if (playerIds.length === 0) return [];
  return db
    .select({
      playerId: playerScores.playerId,
      gameweekNumber: gameweeks.number,
      totalPoints: playerScores.totalPoints,
    })
    .from(playerScores)
    .innerJoin(gameweeks, eq(playerScores.gameweekId, gameweeks.id))
    .where(inArray(playerScores.playerId, playerIds))
    .orderBy(desc(gameweeks.number));
}

/** Upserts PlayerScore rows for a Match — idempotent on (playerId, matchId), safe to re-run. */
export async function replaceForMatch(_matchId: string, scores: PlayerScore[]): Promise<void> {
  if (scores.length === 0) return;
  await db
    .insert(playerScores)
    .values(
      scores.map((score) => ({
        id: score.id,
        playerId: score.playerId,
        matchId: score.matchId,
        gameweekId: score.gameweekId,
        breakdown: score.breakdown,
        totalPoints: score.totalPoints,
        calculatedAt: score.calculatedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [playerScores.playerId, playerScores.matchId],
      set: {
        gameweekId: sql`excluded.gameweek_id`,
        breakdown: sql`excluded.breakdown`,
        totalPoints: sql`excluded.total_points`,
        calculatedAt: sql`excluded.calculated_at`,
      },
    });
}
