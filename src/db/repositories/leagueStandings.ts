import { and, asc, desc, eq } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { gameweeks, leagueStandings } from "../schema";
import type { LeagueStanding, LeagueStandingTiebreakerStats } from "../../domain";

function toLeagueStanding(row: typeof leagueStandings.$inferSelect): LeagueStanding {
  return {
    id: row.id,
    leagueId: row.leagueId,
    gameweekId: row.gameweekId,
    teamId: row.teamId,
    rank: row.rank,
    totalPoints: row.totalPoints,
    tiebreakerStats: row.tiebreakerStats as LeagueStandingTiebreakerStats,
    calculatedAt: row.calculatedAt,
  };
}

/** Replaces every LeagueStanding row for a (league, gameweek) pair — delete-then-insert keeps re-running idempotent.
 * Pass a `tx` so the write joins the same transaction as the reads that computed these rows (updateStandings). */
export async function replaceForGameweek(
  leagueId: string,
  gameweekId: string,
  rows: LeagueStanding[],
  tx?: DbOrTx,
): Promise<void> {
  const client = tx ?? db;
  await client
    .delete(leagueStandings)
    .where(and(eq(leagueStandings.leagueId, leagueId), eq(leagueStandings.gameweekId, gameweekId)));
  if (rows.length === 0) return;
  await client.insert(leagueStandings).values(
    rows.map((row) => ({
      id: row.id,
      leagueId: row.leagueId,
      gameweekId: row.gameweekId,
      teamId: row.teamId,
      rank: row.rank,
      totalPoints: row.totalPoints,
      tiebreakerStats: row.tiebreakerStats,
      calculatedAt: row.calculatedAt,
    })),
  );
}

export async function findForLeagueAndGameweek(leagueId: string, gameweekId: string): Promise<LeagueStanding[]> {
  const rows = await db
    .select()
    .from(leagueStandings)
    .where(and(eq(leagueStandings.leagueId, leagueId), eq(leagueStandings.gameweekId, gameweekId)))
    .orderBy(asc(leagueStandings.rank));
  return rows.map(toLeagueStanding);
}

/** The leaderboard as of the most recent gameweek this league has standings for. Empty before any gameweek completes. */
export async function findLatestForLeague(leagueId: string): Promise<LeagueStanding[]> {
  const [latest] = await db
    .select({ gameweekId: leagueStandings.gameweekId })
    .from(leagueStandings)
    .innerJoin(gameweeks, eq(leagueStandings.gameweekId, gameweeks.id))
    .where(eq(leagueStandings.leagueId, leagueId))
    .orderBy(desc(gameweeks.number))
    .limit(1);
  if (!latest) return [];
  return findForLeagueAndGameweek(leagueId, latest.gameweekId);
}
