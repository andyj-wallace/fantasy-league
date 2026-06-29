import { playersRepository } from "../db/repositories";
import type { FootballDataProvider } from "./footballDataProvider";

/** Pulls the full Premier League player list from the provider and upserts every entry by
 * externalId — the only path that creates Player rows. Needed before fixture player-stat
 * imports or availability syncs have anyone to attribute provider data to. */
export async function importPlayerRoster(provider: FootballDataProvider): Promise<void> {
  const rosterEntries = await provider.fetchPlayerRoster();
  for (const entry of rosterEntries) {
    await playersRepository.upsertFromRosterImport(entry);
  }
}
