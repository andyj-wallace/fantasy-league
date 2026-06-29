import { and, eq, gte, inArray, lte, or } from "drizzle-orm";
import { db } from "../client";
import { matches } from "../schema";
import type { Match } from "../../domain";

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

/** Matches the live-polling tick should consider checking: already in play, or scheduled/delayed
 * fixtures whose kickoff has passed but we haven't yet observed a status change for. */
export async function findPotentiallyLive(now: Date): Promise<Match[]> {
  const rows = await db
    .select()
    .from(matches)
    .where(
      or(
        eq(matches.status, "IN_PROGRESS"),
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
        status: match.status,
        finalHomeScore: match.finalHomeScore,
        finalAwayScore: match.finalAwayScore,
      },
    });
}
