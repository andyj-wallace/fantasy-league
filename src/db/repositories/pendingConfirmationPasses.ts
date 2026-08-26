import { randomUUID } from "node:crypto";
import { asc, count, eq, lte } from "drizzle-orm";
import { db } from "../client";
import { pendingConfirmationPasses } from "../schema";

export interface PendingConfirmationPass {
  id: string;
  matchId: string;
  externalFixtureId: string;
  dueAt: Date;
  /** Failed attempts so far; 0 for a pass that has never been tried. */
  attemptCount: number;
  lastAttemptedAt: Date | null;
  lastError: string | null;
}

/** What one failed attempt writes back: the retry bookkeeping plus the deferred due time that
 * stops the pass coming straight back on the next worker cycle. */
export interface FailedConfirmationPassAttempt {
  attemptCount: number;
  lastAttemptedAt: Date;
  lastError: string;
  nextDueAt: Date;
}

/**
 * Ceiling on how many due passes one worker cycle takes on. A 3pm blackout finishes at most ten
 * Premier League fixtures together, so this is headroom rather than a real limit — it exists so
 * that a backlog (a worker that was down over a matchday, say) is worked off a batch at a time
 * instead of turning one cycle into an unbounded run of 2-calls-per-pass provider traffic.
 */
export const MAX_CONFIRMATION_PASSES_PER_CYCLE = 20;

function toPass(row: typeof pendingConfirmationPasses.$inferSelect): PendingConfirmationPass {
  return {
    id: row.id,
    matchId: row.matchId,
    externalFixtureId: row.externalFixtureId,
    dueAt: row.dueAt,
    attemptCount: row.attemptCount,
    lastAttemptedAt: row.lastAttemptedAt,
    lastError: row.lastError,
  };
}

export async function schedule(matchId: string, externalFixtureId: string, dueAt: Date): Promise<void> {
  await db.insert(pendingConfirmationPasses).values({ id: randomUUID(), matchId, externalFixtureId, dueAt });
}

/**
 * The passes that have come due, oldest first and capped at one cycle's worth.
 *
 * Oldest-first matters because a deferred pass has its dueAt pushed into the future: ordering by
 * due_at serves the passes that have waited longest before the ones already in backoff, rather
 * than leaving the order to whatever the planner happens to return.
 */
export async function findDue(now: Date): Promise<PendingConfirmationPass[]> {
  const rows = await db
    .select()
    .from(pendingConfirmationPasses)
    .where(lte(pendingConfirmationPasses.dueAt, now))
    .orderBy(asc(pendingConfirmationPasses.dueAt))
    .limit(MAX_CONFIRMATION_PASSES_PER_CYCLE);
  return rows.map(toPass);
}

/**
 * How many confirmation passes the live-poll budget still has to reserve provider calls for (2
 * each — see the arithmetic in runLiveMatchPollingTick and docs/polling-budget.md).
 *
 * Every row counts, passes that are not due yet included: their 2 calls are coming regardless, and
 * reserving late is what over-spends the early rounds.
 *
 * What keeps that number honest is not a predicate here but the dead-letter policy in
 * runDueConfirmationPasses. Before 2026-08-26 a pass that could never succeed stayed in this table
 * forever, holding 2 calls of reserve and tightening the live cadence in payment for calls that
 * were never going to be made. Such a pass is now abandoned — deleted — on its fifth failed
 * attempt, and the attempt cap is checked *before* the attempt is written, so no row is ever
 * persisted at it. Every row this counts is therefore one that will genuinely be attempted; a
 * filter on attempt_count here would be unreachable code. The invariant is pinned by
 * confirmationPasses.test.ts ("never records an attempt count at the cap").
 */
export async function countOwed(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(pendingConfirmationPasses);
  return row?.value ?? 0;
}

/** Records a failed attempt and defers the pass to its backoff's next due time. */
export async function recordFailedAttempt(id: string, attempt: FailedConfirmationPassAttempt): Promise<void> {
  await db
    .update(pendingConfirmationPasses)
    .set({
      attemptCount: attempt.attemptCount,
      lastAttemptedAt: attempt.lastAttemptedAt,
      lastError: attempt.lastError,
      dueAt: attempt.nextDueAt,
    })
    .where(eq(pendingConfirmationPasses.id, id));
}

export async function remove(id: string): Promise<void> {
  await db.delete(pendingConfirmationPasses).where(eq(pendingConfirmationPasses.id, id));
}
