import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { gameweeks, leagueStandings, teams } from "../schema";
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

/** Excludes rows for a Team that's since been removed from the league — a removed manager's
 * standings disappear from every gameweek's leaderboard, including already-completed ones, with
 * no attempt to renumber the remaining ranks (a gap like 1, 3, 4 is left as-is; recomputing display
 * rank from stored tiebreaker stats would reintroduce compute-on-read). */
export async function findForLeagueAndGameweek(leagueId: string, gameweekId: string): Promise<LeagueStanding[]> {
  const rows = await db
    .select({ standing: leagueStandings })
    .from(leagueStandings)
    .innerJoin(teams, eq(leagueStandings.teamId, teams.id))
    .where(
      and(
        eq(leagueStandings.leagueId, leagueId),
        eq(leagueStandings.gameweekId, gameweekId),
        isNull(teams.removedAt),
      ),
    )
    .orderBy(asc(leagueStandings.rank));
  return rows.map((row) => toLeagueStanding(row.standing));
}

/** The leaderboard as of the most recent gameweek this league has standings for. Empty before any gameweek completes. */
export async function findLatestForLeague(leagueId: string): Promise<LeagueStanding[]> {
  const [latest] = await db
    .select({ gameweekId: leagueStandings.gameweekId })
    .from(leagueStandings)
    .innerJoin(gameweeks, eq(leagueStandings.gameweekId, gameweeks.id))
    .innerJoin(teams, eq(leagueStandings.teamId, teams.id))
    .where(and(eq(leagueStandings.leagueId, leagueId), isNull(teams.removedAt)))
    .orderBy(desc(gameweeks.number))
    .limit(1);
  if (!latest) return [];
  return findForLeagueAndGameweek(leagueId, latest.gameweekId);
}
