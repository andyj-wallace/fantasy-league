import { ApiFootballProvider } from "./apiFootballProvider";
import type { FootballDataProvider } from "./footballDataProvider";
import { OfflineFootballDataProvider } from "./offlineFootballDataProvider";

/**
 * Builds the football data provider from env vars — the one place that decides which provider
 * implementation backs the workers and API (mirrors createAuthProviderFromEnv.ts).
 *
 * `FOOTBALL_DATA_PROVIDER=offline` selects OfflineFootballDataProvider, which replays the
 * recorded response envelopes in src/workers/__fixtures__/ and never touches the network — for
 * local dev and the import-layer regression tests. Anything else selects the real
 * ApiFootballProvider. FOOTBALL_DATA_SEASON_YEAR is an initial fallback only — the worker's
 * monthly season sync overwrites it via setCurrentSeason() once the DB row is resolved.
 */
export function createFootballDataProviderFromEnv(): FootballDataProvider {
  const seasonYear = Number(process.env.FOOTBALL_DATA_SEASON_YEAR ?? 2024);

  if (process.env.FOOTBALL_DATA_PROVIDER === "offline") {
    return new OfflineFootballDataProvider(seasonYear);
  }

  const baseUrl = process.env.FOOTBALL_DATA_API_BASE_URL ?? "https://v3.football.api-sports.io";
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) throw new Error("FOOTBALL_DATA_API_KEY is not set");
  return new ApiFootballProvider(baseUrl, apiKey, seasonYear);
}
