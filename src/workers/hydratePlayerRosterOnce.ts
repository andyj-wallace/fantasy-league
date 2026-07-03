import "dotenv/config";
import { playersRepository } from "../db/repositories";
import { createFootballDataProviderFromEnv } from "./createFootballDataProviderFromEnv";
import { importAllPlayersForSeason } from "./importAllPlayersForSeason";

/**
 * One-time, manually-triggered pre-season hydration and upserts every Player at the flat
 * per-position default price.
 *
 * Dev-only deliberate scope: uses only importAllPlayersForSeason (paginated /players) and
 * skips importPlayerRoster (/players/squads, one call per club). The squad-snapshot path needs
 * ~20 back-to-back calls with no league-wide equivalent, which the free API-Football plan's
 * per-minute limit can't sustain (see the 429s this produced even with a 5s inter-request
 * delay) — not worth fighting on a free key just to build against in dev. /players is capped to
 * the first 3 pages (~60 players) on the free tier too, but that's enough real data to build and
 * validate the squad-builder flow against. Once on a paid plan, re-add importPlayerRoster here
 * (or call it directly) for full-roster completeness and tune INTER_REQUEST_DELAY_MS down to
 * match the higher rate limit.
 *
 * Not wired into runWorkerCycle/cron — run by hand (see docs/initial-player-pricing.md for the
 * separate, not-yet-built step that replaces the flat default with a real computed price).
 *
 * Safe to re-run: upsertFromRosterImport is keyed on externalId and never overwrites an existing
 * priceInMillions.
 */
async function main(): Promise<void> {
  const provider = createFootballDataProviderFromEnv();
  const before = await playersRepository.findMany({});

  await importAllPlayersForSeason(provider);

  const after = await playersRepository.findMany({});

  if (after.length === 0) {
    console.warn(
      "WARNING: zero players returned. API-Football may not have this season's data populated yet " +
        "(see docs/remaining-gaps-todo.md) — try overriding FOOTBALL_DATA_SEASON_YEAR to a completed season to confirm the import path works.",
    );
  }

  const byPosition = after.reduce<Record<string, number>>((counts, player) => {
    counts[player.position] = (counts[player.position] ?? 0) + 1;
    return counts;
  }, {});

  console.log(
    JSON.stringify(
      {
        totalPlayersBefore: before.length,
        totalPlayersAfter: after.length,
        newPlayersAdded: after.length - before.length,
        byPosition,
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
