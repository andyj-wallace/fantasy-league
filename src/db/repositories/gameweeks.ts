import { asc, eq, ne } from "drizzle-orm";
import { db } from "../client";
import { gameweeks, matches } from "../schema";
import type { Gameweek } from "../../domain";

function toGameweek(row: typeof gameweeks.$inferSelect): Gameweek {
  return { id: row.id, number: row.number, deadlineAt: row.deadlineAt, status: row.status };
}

export async function findById(id: string): Promise<Gameweek | null> {
  const [row] = await db.select().from(gameweeks).where(eq(gameweeks.id, id));
  return row ? toGameweek(row) : null;
}

/** The gameweek transfers/lineup changes apply to right now: the lowest-numbered one not yet COMPLETED. */
export async function findCurrent(): Promise<Gameweek | null> {
  const [row] = await db
    .select()
    .from(gameweeks)
    .where(ne(gameweeks.status, "COMPLETED"))
    .orderBy(asc(gameweeks.number))
    .limit(1);
  return row ? toGameweek(row) : null;
}

/** True only once the gameweek has at least one Match and every one of them has reached COMPLETED. */
export async function areAllMatchesCompleted(gameweekId: string): Promise<boolean> {
  const rows = await db
    .select({ status: matches.status })
    .from(matches)
    .where(eq(matches.gameweekId, gameweekId));
  return rows.length > 0 && rows.every((row) => row.status === "COMPLETED");
}

export async function markCompleted(gameweekId: string): Promise<void> {
  await db.update(gameweeks).set({ status: "COMPLETED" }).where(eq(gameweeks.id, gameweekId));
}
