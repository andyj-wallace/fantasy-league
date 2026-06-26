import { and, eq, lte } from "drizzle-orm";
import { db } from "../client";
import { gameweeks, teamScores } from "../schema";
import type { TeamScore } from "../../domain";

/** Replaces every TeamScore row for a gameweek — delete-then-insert keeps re-running idempotent. */
export async function replaceForGameweek(gameweekId: string, scores: TeamScore[]): Promise<void> {
  await db.delete(teamScores).where(eq(teamScores.gameweekId, gameweekId));
  if (scores.length === 0) return;
  await db.insert(teamScores).values(
    scores.map((score) => ({
      id: score.id,
      teamId: score.teamId,
      gameweekId: score.gameweekId,
      captainBonusPlayerId: score.captainBonusPlayerId,
      totalPoints: score.totalPoints,
      calculatedAt: score.calculatedAt,
    })),
  );
}

/** Cumulative season total for a Team through a given gameweek number — the basis of the leaderboard. */
export async function sumTotalPointsThroughGameweek(
  teamId: string,
  gameweekNumber: number,
): Promise<number> {
  const rows = await db
    .select({ totalPoints: teamScores.totalPoints })
    .from(teamScores)
    .innerJoin(gameweeks, eq(teamScores.gameweekId, gameweeks.id))
    .where(and(eq(teamScores.teamId, teamId), lte(gameweeks.number, gameweekNumber)));
  return rows.reduce((sum, row) => sum + row.totalPoints, 0);
}
