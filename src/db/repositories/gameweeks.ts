import { asc, eq, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, type DbOrTx } from "../client";
import { gameweeks, matches } from "../schema";
import type { Gameweek } from "../../domain";

function toGameweek(row: typeof gameweeks.$inferSelect): Gameweek {
  return { id: row.id, number: row.number, deadlineAt: row.deadlineAt, status: row.status };
}

export async function findById(id: string, tx?: DbOrTx): Promise<Gameweek | null> {
  const [row] = await (tx ?? db).select().from(gameweeks).where(eq(gameweeks.id, id));
  return row ? toGameweek(row) : null;
}

export async function findByNumber(number: number): Promise<Gameweek | null> {
  const [row] = await db.select().from(gameweeks).where(eq(gameweeks.number, number));
  return row ? toGameweek(row) : null;
}

/** Creates the Gameweek the first time a fixture in that round is discovered, or tightens
 * deadlineAt as earlier kickoffs in the same round are found. */
export async function upsertByNumber(number: number, candidateDeadlineAt: Date): Promise<Gameweek> {
  const [row] = await db
    .insert(gameweeks)
    .values({ id: randomUUID(), number, deadlineAt: candidateDeadlineAt, status: "UPCOMING" })
    .onConflictDoUpdate({
      target: gameweeks.number,
      set: { deadlineAt: sql`LEAST(${gameweeks.deadlineAt}, ${candidateDeadlineAt})` },
    })
    .returning();
  return toGameweek(row!);
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

/** Test/seed-only: explicitly reopens a gameweek — resets status to UPCOMING and moves its
 * deadline into the future, regardless of upsertByNumber's LEAST-clamping (which only ever
 * tightens a deadline, never touches status). Used to turn a long-past, already-COMPLETED
 * gameweek back into a testable one for local squad-building/transfers. */
export async function reopenForTesting(gameweekId: string, deadlineAt: Date): Promise<void> {
  await db.update(gameweeks).set({ status: "UPCOMING", deadlineAt }).where(eq(gameweeks.id, gameweekId));
}
