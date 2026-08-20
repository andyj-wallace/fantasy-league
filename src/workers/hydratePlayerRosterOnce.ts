import "dotenv/config";
import { playersRepository } from "../db/repositories";
import { createFootballDataProviderFromEnv } from "./createFootballDataProviderFromEnv";
import { importAllPlayersForSeason } from "./importAllPlayersForSeason";
import { importPlayerRoster } from "./importPlayerRoster";

/**
 * One-time, manually-triggered pre-season hydration. Upserts every Player: full squads via
 * importPlayerRoster (/players/squads, the primary source), then importAllPlayersForSeason
 * (/players, paginated) as a catch-all for players a club's current squad block doesn't
 * surface — new signings, promoted-club players. New players get the flat per-position
 * default price; run `npm run hydrate:initial-pricing` afterward to replace it with a real
 * previous-season-derived price (see docs/initial-player-pricing.md).
 *
 * Requires a paid API-Football plan — importPlayerRoster's ~20 back-to-back per-club calls
 * 429'd on the free tier's per-minute limit even at a 5s inter-request delay (see
 * docs/pro-tier-player-hydration.md). Tune FOOTBALL_DATA_REQUEST_DELAY_MS to the plan's
 * actual per-minute limit.
 *
 * FOOTBALL_DATA_SEASON_YEAR must be set to a season API-Football has actually populated —
 * check /leagues?id=39's coverage.players flag before relying on the default; the
 * current/upcoming season typically has none until games are underway. See
 * docs/pro-tier-player-hydration.md for the season this was last confirmed against.
 *
 * Not wired into runWorkerCycle/cron — run by hand.
 *
 * Safe to re-run: upsertFromRosterImport is keyed on externalId and never overwrites an
 * existing priceInMillions.
 */
async function main(): Promise<void> {
  const provider = createFootballDataProviderFromEnv();
  const before = await playersRepository.findMany({});

  await importPlayerRoster(provider);
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
