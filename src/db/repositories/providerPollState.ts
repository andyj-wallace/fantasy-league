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

/**
 * Fixed id for the single provider_poll_state row. Using a constant (rather than a random id)
 * lets the create path lean on the primary key as an ON CONFLICT target, so two worker cold
 * starts that both see an empty table can't each insert a separate row.
 */
const PROVIDER_POLL_STATE_SINGLETON_ID = "00000000-0000-0000-0000-000000000001";

/** There is exactly one row in this table; creates it on first use. */
export async function getOrCreate(): Promise<ProviderPollState> {
  // Return any existing row as-is — including a legacy random-id row from before the singleton id,
  // so this never orphans previously-accumulated poll state.
  const [existing] = await db.select().from(providerPollState).limit(1);
  if (existing) return toState(existing);

  // Empty table: concurrent cold starts both reach here, but both target the same primary key, so
  // the loser's insert no-ops (ON CONFLICT DO NOTHING) instead of creating a second row.
  await db.insert(providerPollState).values({ id: PROVIDER_POLL_STATE_SINGLETON_ID }).onConflictDoNothing();
  const [created] = await db.select().from(providerPollState).limit(1);
  return toState(created!);
}

export async function update(id: string, fields: Partial<Omit<ProviderPollState, "id">>): Promise<void> {
  await db.update(providerPollState).set(fields).where(eq(providerPollState.id, id));
}
