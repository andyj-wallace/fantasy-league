import { and, eq, lte } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { gameweeks, teamScores } from "../schema";
import type { TeamScore } from "../../domain";

function toTeamScore(row: typeof teamScores.$inferSelect): TeamScore {
  return {
    id: row.id,
    teamId: row.teamId,
    gameweekId: row.gameweekId,
    captainBonusPlayerId: row.captainBonusPlayerId,
    totalPoints: row.totalPoints,
    calculatedAt: row.calculatedAt,
  };
}

export async function findByTeamAndGameweek(teamId: string, gameweekId: string): Promise<TeamScore | null> {
  const [row] = await db
    .select()
    .from(teamScores)
    .where(and(eq(teamScores.teamId, teamId), eq(teamScores.gameweekId, gameweekId)));
  return row ? toTeamScore(row) : null;
}

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

/** Cumulative season total for a Team through a given gameweek number — the basis of the leaderboard.
 * Pass a `tx` to read within a caller-owned transaction (e.g. updateStandings' consistent snapshot). */
export async function sumTotalPointsThroughGameweek(
  teamId: string,
  gameweekNumber: number,
  tx?: DbOrTx,
): Promise<number> {
  const rows = await (tx ?? db)
    .select({ totalPoints: teamScores.totalPoints })
    .from(teamScores)
    .innerJoin(gameweeks, eq(teamScores.gameweekId, gameweeks.id))
    .where(and(eq(teamScores.teamId, teamId), lte(gameweeks.number, gameweekNumber)));
  return rows.reduce((sum, row) => sum + row.totalPoints, 0);
}
