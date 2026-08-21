import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../client";
import { gameweeks, playerScores } from "../schema";
import type { PlayerGameweekPoints, PlayerScore } from "../../domain";

/** SQL for "did this row's player take the field", from the stored breakdown's appearance points.
 * Coalesced because rows written before a breakdown key existed would otherwise yield NULL. */
const didAppearExpression = sql<boolean>`coalesce((${playerScores.breakdown} ->> 'appearancePoints')::int, 0) > 0`;

/**
 * A player's collapsed points for one gameweek, or null if they have no scored match in it.
 * Sums across rows rather than returning the first: (playerId, matchId) is unique but
 * (playerId, gameweekId) is not, so a club with two matches attributed to one gameweek — a
 * postponed fixture replayed under its original round label — would otherwise be under-counted.
 */
export async function findPlayerGameweekPoints(
  playerId: string,
  gameweekId: string,
): Promise<PlayerGameweekPoints | null> {
  const [row] = await db
    .select({
      scoredMatchCount: sql<number>`count(*)::int`,
      totalPoints: sql<number>`coalesce(sum(${playerScores.totalPoints}), 0)::int`,
      didAppear: sql<boolean>`coalesce(bool_or(${didAppearExpression}), false)`,
    })
    .from(playerScores)
    .where(and(eq(playerScores.playerId, playerId), eq(playerScores.gameweekId, gameweekId)));

  if (!row || row.scoredMatchCount === 0) return null;
  return { totalPoints: row.totalPoints, didAppear: row.didAppear };
}

/** Every scored match's points for the given players, newest gameweek first — the shape squad-
 * builder player cards need for total points, recent form, and per-gameweek points, without
 * carrying the full breakdown jsonb across the wire for every row. */
export async function findManyByPlayerIds(
  playerIds: string[],
): Promise<{ playerId: string; gameweekNumber: number; totalPoints: number; didAppear: boolean }[]> {
  if (playerIds.length === 0) return [];
  return db
    .select({
      playerId: playerScores.playerId,
      gameweekNumber: gameweeks.number,
      totalPoints: playerScores.totalPoints,
      didAppear: didAppearExpression,
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
