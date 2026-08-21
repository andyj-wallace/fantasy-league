import type { ProviderLeagueSeason } from "./footballDataProvider";

/**
 * Decides which season a roster import is allowed to touch, or throws saying why it isn't allowed
 * to touch the one it was pointed at.
 *
 * This is the guard `hydrate:roster` exists to enforce, kept pure and separate so it can be read
 * and tested without a provider. Its absence caused a real defect: a run configured with
 * `FOOTBALL_DATA_SEASON_YEAR=2025` resolved clubs via `/teams?league=39&season=2025` and imported
 * the *previous* season's twenty, pulling in 71 relegated-club players. Nothing objected, because
 * nothing knew which season was current. So the provider's own answer leads, a disagreeing
 * environment variable stops the run, and pointing at a completed season — a legitimate debugging
 * move — has to be said out loud.
 */
export function resolveRosterImportSeason(
  seasons: readonly ProviderLeagueSeason[],
  configuredSeasonYear: number | null,
  seasonOverrideYear: number | null,
): ProviderLeagueSeason {
  const currentSeason = seasons.find((season) => season.isCurrentSeason);

  if (seasonOverrideYear !== null) {
    const overriddenSeason = seasons.find((season) => season.seasonYear === seasonOverrideYear);
    if (!overriddenSeason) {
      throw new Error(
        `--season-override ${seasonOverrideYear} names a season the provider does not hold for this league ` +
          `(it holds ${seasons.map((season) => season.seasonYear).join(", ") || "none"}).`,
      );
    }
    console.warn(
      `[hydrate:roster] season guard bypassed: importing season ${seasonOverrideYear}` +
        (currentSeason && currentSeason.seasonYear !== seasonOverrideYear
          ? `, which is not the current season (${currentSeason.seasonYear})`
          : "") +
        ". Every club and squad imported below is that season's, not today's.",
    );
    return overriddenSeason;
  }

  if (!currentSeason) {
    throw new Error(
      "The provider did not report a current season for this league, so there is no season this run can " +
        "safely lead with. Re-run once the provider is reachable, or name one with --season-override <year>.",
    );
  }

  if (configuredSeasonYear !== null && configuredSeasonYear !== currentSeason.seasonYear) {
    throw new Error(
      `FOOTBALL_DATA_SEASON_YEAR=${configuredSeasonYear} but the provider's current season is ` +
        `${currentSeason.seasonYear}. Importing a completed season pulls in that season's twenty clubs — ` +
        "relegated clubs included — so this run is refused. Unset FOOTBALL_DATA_SEASON_YEAR to import the " +
        `current season, or pass --season-override ${configuredSeasonYear} if a completed season is genuinely ` +
        "what you want.",
    );
  }

  return currentSeason;
}
