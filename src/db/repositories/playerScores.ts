import { and, eq } from "drizzle-orm";
import { db } from "../client";
import { playerScores } from "../schema";
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

/** Replaces every PlayerScore row for a Match — delete-then-insert keeps re-running idempotent. */
export async function replaceForMatch(matchId: string, scores: PlayerScore[]): Promise<void> {
  await db.delete(playerScores).where(eq(playerScores.matchId, matchId));
  if (scores.length === 0) return;
  await db.insert(playerScores).values(
    scores.map((score) => ({
      id: score.id,
      playerId: score.playerId,
      matchId: score.matchId,
      gameweekId: score.gameweekId,
      breakdown: score.breakdown,
      totalPoints: score.totalPoints,
      calculatedAt: score.calculatedAt,
    })),
  );
}
