import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../client";
import { providerPollState } from "../schema";

export interface ProviderPollState {
  id: string;
  lastDiscoveryRanAt: Date | null;
  lastRosterImportRanAt: Date | null;
  lastAvailabilitySyncRanAt: Date | null;
  nextLivePollDueAt: Date | null;
  currentSeasonYear: number | null;
  coverageFixturePlayerStats: boolean;
  coverageInjuries: boolean;
  lastSeasonSyncRanAt: Date | null;
}

function toState(row: typeof providerPollState.$inferSelect): ProviderPollState {
  return {
    id: row.id,
    lastDiscoveryRanAt: row.lastDiscoveryRanAt,
    lastRosterImportRanAt: row.lastRosterImportRanAt,
    lastAvailabilitySyncRanAt: row.lastAvailabilitySyncRanAt,
    nextLivePollDueAt: row.nextLivePollDueAt,
    currentSeasonYear: row.currentSeasonYear,
    coverageFixturePlayerStats: row.coverageFixturePlayerStats,
    coverageInjuries: row.coverageInjuries,
    lastSeasonSyncRanAt: row.lastSeasonSyncRanAt,
  };
}

/** There is exactly one row in this table; creates it on first use. */
export async function getOrCreate(): Promise<ProviderPollState> {
  const [existing] = await db.select().from(providerPollState).limit(1);
  if (existing) return toState(existing);

  const [created] = await db.insert(providerPollState).values({ id: randomUUID() }).returning();
  return toState(created!);
}

export async function update(id: string, fields: Partial<Omit<ProviderPollState, "id">>): Promise<void> {
  await db.update(providerPollState).set(fields).where(eq(providerPollState.id, id));
}
