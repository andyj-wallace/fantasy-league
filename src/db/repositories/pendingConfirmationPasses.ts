import { randomUUID } from "node:crypto";
import { eq, lte } from "drizzle-orm";
import { db } from "../client";
import { pendingConfirmationPasses } from "../schema";

export interface PendingConfirmationPass {
  id: string;
  matchId: string;
  externalFixtureId: string;
  dueAt: Date;
}

function toPass(row: typeof pendingConfirmationPasses.$inferSelect): PendingConfirmationPass {
  return { id: row.id, matchId: row.matchId, externalFixtureId: row.externalFixtureId, dueAt: row.dueAt };
}

export async function schedule(matchId: string, externalFixtureId: string, dueAt: Date): Promise<void> {
  await db.insert(pendingConfirmationPasses).values({ id: randomUUID(), matchId, externalFixtureId, dueAt });
}

export async function findDue(now: Date): Promise<PendingConfirmationPass[]> {
  const rows = await db.select().from(pendingConfirmationPasses).where(lte(pendingConfirmationPasses.dueAt, now));
  return rows.map(toPass);
}

export async function countOwed(): Promise<number> {
  const rows = await db.select({ id: pendingConfirmationPasses.id }).from(pendingConfirmationPasses);
  return rows.length;
}

export async function remove(id: string): Promise<void> {
  await db.delete(pendingConfirmationPasses).where(eq(pendingConfirmationPasses.id, id));
}
