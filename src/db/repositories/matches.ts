import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "../client";
import { matches } from "../schema";
import { MATCH_STATUSES_UNDER_WAY_BUT_NOT_YET_RESOLVED, type Match } from "../../domain";

function toMatch(row: typeof matches.$inferSelect): Match {
  return {
    id: row.id,
    externalId: row.externalId,
    gameweekId: row.gameweekId,
    homeClub: row.homeClub,
    awayClub: row.awayClub,
    kickoffAt: row.kickoffAt,
    status: row.status,
    finalHomeScore: row.finalHomeScore,
    finalAwayScore: row.finalAwayScore,
  };
}

export async function findById(id: string): Promise<Match | null> {
  const [row] = await db.select().from(matches).where(eq(matches.id, id));
  return row ? toMatch(row) : null;
}

/** Every Match in a Gameweek — used to derive which clubs (and so which Players) are locked. */
export async function findByGameweekId(gameweekId: string): Promise<Match[]> {
  const rows = await db.select().from(matches).where(eq(matches.gameweekId, gameweekId));
  return rows.map(toMatch);
}

export async function findByExternalId(externalId: string): Promise<Match | null> {
  const [row] = await db.select().from(matches).where(eq(matches.externalId, externalId));
  return row ? toMatch(row) : null;
}

/** Matches the live-polling tick should consider checking: already under way and unresolved
 * (in play or interrupted — see MATCH_STATUSES_UNDER_WAY_BUT_NOT_YET_RESOLVED), or scheduled/delayed
 * fixtures whose kickoff has passed but we haven't yet observed a status change for.
 *
 * Deliberately unbounded below: a row far past its kickoff is returned here, and it is
 * liveMatchPolling that applies MATCH_POLLING_ABANDONMENT_WINDOW_MS and stops spending provider
 * calls on it. Adding that cutoff as a predicate here would save nothing worth having — the cost
 * being avoided is provider calls, not a local indexed read over a few hundred fixtures a season —
 * and it would cost the thing that matters: an abandoned row would vanish from the poller's sight
 * silently, while still blocking its gameweek forever (its status is still one of
 * MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION). The poller has to see what it is giving up on
 * in order to log it. Note also
 * that findEarliestUpcomingKickoff below *is* bounded — that asymmetry is intentional, not an
 * oversight: it answers "when should we next wake up", which only future kickoffs can inform. */
export async function findPotentiallyLive(now: Date): Promise<Match[]> {
  const rows = await db
    .select()
    .from(matches)
    .where(
      or(
        inArray(matches.status, MATCH_STATUSES_UNDER_WAY_BUT_NOT_YET_RESOLVED),
        and(inArray(matches.status, ["SCHEDULED", "DELAYED"]), lte(matches.kickoffAt, now)),
      ),
    );
  return rows.map(toMatch);
}

/** The earliest kickoff among matches that haven't reached a final state — used to know when to
 * next wake the live-polling tick if nothing is currently live. */
export async function findEarliestUpcomingKickoff(now: Date): Promise<Date | null> {
  const rows = await db
    .select({ kickoffAt: matches.kickoffAt })
    .from(matches)
    .where(and(inArray(matches.status, ["SCHEDULED", "DELAYED"]), gte(matches.kickoffAt, now)));
  if (rows.length === 0) return null;
  return rows.reduce((earliest, row) => (row.kickoffAt < earliest ? row.kickoffAt : earliest), rows[0]!.kickoffAt);
}

/** Inserts a never-before-seen Match (keyed by the provider's externalId), or updates the mutable
 * fields of one already imported. */
export async function upsert(match: Match): Promise<void> {
  if (!match.externalId) throw new Error("matches.upsert requires an externalId");
  await db
    .insert(matches)
    .values({
      id: match.id,
      externalId: match.externalId,
      gameweekId: match.gameweekId,
      homeClub: match.homeClub,
      awayClub: match.awayClub,
      kickoffAt: match.kickoffAt,
      status: match.status,
      finalHomeScore: match.finalHomeScore,
      finalAwayScore: match.finalAwayScore,
    })
    .onConflictDoUpdate({
      target: matches.externalId,
      set: {
        // kickoffAt is mutable too: a postponed fixture is re-reported by the provider with its
        // rescheduled date, and lock checks (isClubLocked) compare kickoffAt against now.
        kickoffAt: match.kickoffAt,
        status: match.status,
        finalHomeScore: match.finalHomeScore,
        finalAwayScore: match.finalAwayScore,
      },
    });
}

/** Test/seed-only: shifts every Match in a gameweek forward by a fixed offset (preserving their
 * relative kickoff spacing) and resets them to SCHEDULED with no final score — the counterpart to
 * gameweeksRepository.reopenForTesting. isClubLocked only cares about kickoffAt vs. now, but
 * leaving old COMPLETED matches/scores behind a future kickoff would still read as inconsistent
 * in the UI, so those reset too. */
export async function rescheduleGameweekIntoFuture(gameweekId: string, offsetDays: number): Promise<void> {
  await db
    .update(matches)
    .set({
      kickoffAt: sql`${matches.kickoffAt} + make_interval(days => ${offsetDays})`,
      status: "SCHEDULED",
      finalHomeScore: null,
      finalAwayScore: null,
    })
    .where(eq(matches.gameweekId, gameweekId));
}
