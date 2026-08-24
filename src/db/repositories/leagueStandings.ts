import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
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

/**
 * The gameweeks this league already has a stored table for, numbered above the given one, earliest
 * first.
 *
 * A standings row's totalPoints is cumulative — sumTotalPointsThroughGameweek over every gameweek
 * up to its own — so rebuilding one gameweek's table silently invalidates every later table the
 * league has already been given. That happens whenever a gameweek is scored late: a postponed
 * fixture replayed weeks on, or a confirmation pass correcting a result. Without this, the stale
 * later row is exactly what findLatestForLeague then serves.
 */
export async function findGameweekIdsWithStandingsAfter(leagueId: string, gameweekNumber: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ gameweekId: leagueStandings.gameweekId, number: gameweeks.number })
    .from(leagueStandings)
    .innerJoin(gameweeks, eq(leagueStandings.gameweekId, gameweeks.id))
    .where(and(eq(leagueStandings.leagueId, leagueId), gt(gameweeks.number, gameweekNumber)))
    .orderBy(asc(gameweeks.number));
  return rows.map((row) => row.gameweekId);
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
