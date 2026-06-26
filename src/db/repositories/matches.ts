import { eq } from "drizzle-orm";
import { db } from "../client";
import { matches } from "../schema";
import type { Match } from "../../domain";

function toMatch(row: typeof matches.$inferSelect): Match {
  return {
    id: row.id,
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

/** Inserts a never-before-seen Match, or updates the mutable fields of one already imported. */
export async function upsert(match: Match): Promise<void> {
  await db
    .insert(matches)
    .values({
      id: match.id,
      gameweekId: match.gameweekId,
      homeClub: match.homeClub,
      awayClub: match.awayClub,
      kickoffAt: match.kickoffAt,
      status: match.status,
      finalHomeScore: match.finalHomeScore,
      finalAwayScore: match.finalAwayScore,
    })
    .onConflictDoUpdate({
      target: matches.id,
      set: {
        status: match.status,
        finalHomeScore: match.finalHomeScore,
        finalAwayScore: match.finalAwayScore,
      },
    });
}
