import "dotenv/config";
import { playersRepository } from "../db/repositories";
import { createFootballDataProviderFromEnv } from "./createFootballDataProviderFromEnv";
import { importAllPlayersForSeason } from "./importAllPlayersForSeason";
import { importPlayerRoster } from "./importPlayerRoster";
import { resolveRosterImportSeason } from "./resolveRosterImportSeason";

/**
 * Manually-triggered roster hydration — `npm run hydrate:roster`. Upserts every Player: full
 * squads via importPlayerRoster (/teams + /players/squads, the primary source), then
 * importAllPlayersForSeason (/players, paginated) as a catch-all for players a club's current
 * squad block doesn't surface. New players get the flat per-position default price; run
 * `npm run hydrate:pricing` afterwards to replace it with a real previous-season-derived price
 * (see docs/new-player-pricing.md).
 *
 * **This script leads with the current season and refuses to run against any other one.** The
 * provider's own /leagues answer decides which season that is, and a disagreeing
 * FOOTBALL_DATA_SEASON_YEAR stops the run rather than steering it. That guard exists because its
 * absence caused a real defect: a run against season 2025 imported the *previous* season's twenty
 * clubs, adding 71 Wolves, Burnley and West Ham players who are not in the league. Pointing at a
 * completed season is still a legitimate debugging move — it just has to be said out loud, with
 * `--season-override <year>`.
 *
 * Requires a paid API-Football plan — importPlayerRoster's ~20 back-to-back per-club calls 429'd
 * on the free tier's per-minute limit even at a 5s inter-request delay (see
 * docs/pro-tier-player-hydration.md). Tune FOOTBALL_DATA_REQUEST_DELAY_MS to the plan's actual
 * per-minute limit.
 *
 * Not wired into runWorkerCycle/cron — run by hand.
 *
 * Safe to re-run: upsertFromRosterImport is keyed on externalId and never overwrites an existing
 * priceInMillions.
 */

interface RosterHydrationArguments {
  /** A season to run against instead of the provider's current one, when the operator means it. */
  seasonOverrideYear: number | null;
  /** Lifts importPlayerRoster's sweep-size anomaly brake, for the one supervised import that
   * legitimately hides most of the table — prod's mock seed giving way to a real roster. */
  allowLargeSweep: boolean;
}

function parseArguments(argv: string[]): RosterHydrationArguments {
  const seasonOverrideIndex = argv.indexOf("--season-override");
  const seasonOverrideValue = seasonOverrideIndex === -1 ? null : argv[seasonOverrideIndex + 1];
  if (seasonOverrideIndex !== -1 && !/^\d{4}$/.test(seasonOverrideValue ?? "")) {
    throw new Error("--season-override needs a four-digit season year, e.g. --season-override 2025");
  }
  return {
    seasonOverrideYear: seasonOverrideValue === null ? null : Number(seasonOverrideValue),
    allowLargeSweep: argv.includes("--allow-large-sweep"),
  };
}

async function main(): Promise<void> {
  const { seasonOverrideYear, allowLargeSweep } = parseArguments(process.argv.slice(2));
  const configuredSeasonYear = process.env.FOOTBALL_DATA_SEASON_YEAR
    ? Number(process.env.FOOTBALL_DATA_SEASON_YEAR)
    : null;

  const provider = createFootballDataProviderFromEnv();

  console.log("[hydrate:roster] resolving the provider's current season (1 call)...");
  const seasons = await provider.fetchLeagueSeasons();
  const seasonToImport = resolveRosterImportSeason(seasons, configuredSeasonYear, seasonOverrideYear);

  provider.setCurrentSeason(seasonToImport.seasonYear, {
    fixturePlayerStats: seasonToImport.coverageFixturePlayerStats,
    injuries: seasonToImport.coverageInjuries,
  });
  console.log(
    `[hydrate:roster] importing season ${seasonToImport.seasonYear} ` +
      `(coverage: players=${seasonToImport.coveragePlayers}, fixture_stats=${seasonToImport.coverageFixturePlayerStats}).`,
  );

  const before = await playersRepository.findMany({});

  await importPlayerRoster(provider, allowLargeSweep ? { maximumSweepShareOfCurrentSquad: 1 } : {});

  // The paginated /players pull is the complement to the squad snapshot, but on a season the
  // provider has no player coverage for it is a guaranteed-empty ~28-call trip. Season 2026 is
  // exactly that case: /teams and /players/squads serve it, /players?league&season returns zero.
  if (seasonToImport.coveragePlayers) {
    await importAllPlayersForSeason(provider);
  } else {
    console.log(
      `[hydrate:roster] skipping the paginated /players catch-all — the provider reports no player ` +
        `coverage for season ${seasonToImport.seasonYear}, so it would spend ~28 calls to return nothing. ` +
        "Squads from /players/squads above are the complete roster for this run.",
    );
  }

  const after = await playersRepository.findMany({});

  if (after.length === 0) {
    console.warn(
      "WARNING: zero players returned. API-Football may not have this season's data populated yet " +
        "(see docs/remaining-gaps-todo.md) — try --season-override against a completed season to confirm the import path works.",
    );
  }

  const inCurrentSeasonSquad = after.filter((player) => player.isInCurrentSeasonSquad);
  const byPosition = inCurrentSeasonSquad.reduce<Record<string, number>>((counts, player) => {
    counts[player.position] = (counts[player.position] ?? 0) + 1;
    return counts;
  }, {});

  console.log(
    JSON.stringify(
      {
        seasonImported: seasonToImport.seasonYear,
        totalPlayersBefore: before.length,
        totalPlayersAfter: after.length,
        newPlayersAdded: after.length - before.length,
        playersInCurrentSeasonSquad: inCurrentSeasonSquad.length,
        clubsInCurrentSeasonSquad: new Set(inCurrentSeasonSquad.map((player) => player.club)).size,
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
