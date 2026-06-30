import { playersRepository } from "../db/repositories";
import type { FootballDataProvider } from "./footballDataProvider";

/** Pulls every player registered in the league for the provider's configured season (paginated,
 * rate-limited) and upserts each by externalId — the complement to importPlayerRoster.ts's
 * squad-snapshot import, for players a club's current squad block doesn't surface (new
 * signings, promoted-club players). Used by the one-time pre-season hydration and intended for
 * the monthly price update pass once that's implemented. */
export async function importAllPlayersForSeason(provider: FootballDataProvider): Promise<void> {
  const entries = await provider.fetchAllPlayersForSeason();
  for (const entry of entries) {
    await playersRepository.upsertFromRosterImport(entry);
  }
}
