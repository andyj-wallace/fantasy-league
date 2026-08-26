import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, type DbOrTx } from "../client";
import { gameweeks, matches } from "../schema";
import { MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION, type Gameweek } from "../../domain";

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

/** The statement behind upsertByNumber. Exported only so gameweeks.test.ts can call `.toSQL()` on
 * the real statement — Drizzle builds SQL lazily, so the test can assert the parameters the driver
 * would receive without a live Postgres. Callers should use upsertByNumber. */
export function buildInsertOrTightenDeadlineStatement(number: number, candidateDeadlineAt: Date) {
  return db
    .insert(gameweeks)
    .values({ id: randomUUID(), number, deadlineAt: candidateDeadlineAt, status: "UPCOMING" })
    .onConflictDoUpdate({
      target: gameweeks.number,
      // candidateDeadlineAt MUST stay wrapped in sql.param with gameweeks.deadlineAt as its
      // encoder. Drizzle only applies a column encoder to a template chunk that is a Column, SQL,
      // Param or SQLWrapper; a bare Date falls through and reaches node-postgres unencoded, which
      // serialises it from LOCAL wall-clock components plus an offset (on BST,
      // "2026-07-01T12:30:00.000+01:00"). deadline_at is `timestamp` WITHOUT time zone, so
      // Postgres casts that literal and DISCARDS the offset, storing the local hour. The INSERT
      // above goes through the column encoder (PgTimestamp.mapToDriverValue -> toISOString(), so
      // UTC), meaning the two write paths in this one statement would disagree by the writing
      // process's UTC offset. Worse, LEAST would then compare the shifted candidate against the
      // stored UTC value, so on any positive offset a genuinely earlier kickoff would never
      // tighten the deadline — defeating the whole point of this upsert.
      set: { deadlineAt: sql`LEAST(${gameweeks.deadlineAt}, ${sql.param(candidateDeadlineAt, gameweeks.deadlineAt)})` },
    })
    .returning();
}

/** Creates the Gameweek the first time a fixture in that round is discovered, or tightens
 * deadlineAt as earlier kickoffs in the same round are found. */
export async function upsertByNumber(number: number, candidateDeadlineAt: Date): Promise<Gameweek> {
  const [row] = await buildInsertOrTightenDeadlineStatement(number, candidateDeadlineAt);
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

/** The highest-numbered COMPLETED gameweek, or null if none has finished. Lets a caller tell
 * "the season is over" (no current gameweek, but gameweeks have been played) apart from
 * "no fixtures have been imported yet". */
export async function findLatestCompleted(): Promise<Gameweek | null> {
  const [row] = await db
    .select()
    .from(gameweeks)
    .where(eq(gameweeks.status, "COMPLETED"))
    .orderBy(desc(gameweeks.number))
    .limit(1);
  return row ? toGameweek(row) : null;
}

/**
 * True only once the gameweek has at least one Match and not one of them is still holding it open.
 * Which statuses those are is MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION's decision, not
 * this function's — the same list summarizeGameweekMatchProgress reads, so the round the worker
 * closes and the round the UI describes as finished are always the same round.
 *
 * Its old name (areAllMatchesCompleted) was already a half-truth — VOIDED counts too — and became
 * a whole one once POSTPONED stopped blocking: the fixtures need not be completed, they need only
 * have stopped being waited on.
 */
export async function hasEveryMatchStoppedBlockingGameweekCompletion(gameweekId: string): Promise<boolean> {
  const rows = await db
    .select({ status: matches.status })
    .from(matches)
    .where(eq(matches.gameweekId, gameweekId));
  return (
    rows.length > 0 &&
    !rows.some((row) => MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION.includes(row.status))
  );
}

/**
 * Closes the gameweek, reporting whether *this* call was the one that closed it.
 *
 * Conditional on purpose. `WHERE id = $1 AND status <> 'COMPLETED'` makes the check and the write
 * one atomic statement, which is what lets the caller key a genuinely one-shot action off it:
 * awardGameweekFreeTransfers adds +2 to every team in the game and keeps no ledger of having done
 * so, and the gameweek row's own status is that ledger. The read-then-write this replaced (findById
 * → compare → update, two statements with no transaction around them) could double-award if two
 * worker cycles overlapped on the same round, and could lose the award outright if the process died
 * between the two writes. No schema change is needed for either fix.
 */
export async function markCompletedIfNotAlready(gameweekId: string): Promise<boolean> {
  const rowsThisCallClosed = await db
    .update(gameweeks)
    .set({ status: "COMPLETED" })
    .where(and(eq(gameweeks.id, gameweekId), ne(gameweeks.status, "COMPLETED")))
    .returning({ id: gameweeks.id });
  return rowsThisCallClosed.length > 0;
}

/** Test/seed-only: explicitly reopens a gameweek — resets status to UPCOMING and moves its
 * deadline into the future, regardless of upsertByNumber's LEAST-clamping (which only ever
 * tightens a deadline, never touches status). Used to turn a long-past, already-COMPLETED
 * gameweek back into a testable one for local squad-building/transfers. */
export async function reopenForTesting(gameweekId: string, deadlineAt: Date): Promise<void> {
  await db.update(gameweeks).set({ status: "UPCOMING", deadlineAt }).where(eq(gameweeks.id, gameweekId));
}
