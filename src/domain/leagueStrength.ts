import {
  DEFAULT_LEAGUE_STRENGTH_MULTIPLIER,
  LEAGUE_STRENGTH_MULTIPLIER_BY_EXTERNAL_LEAGUE_ID,
} from "./constants";

/**
 * How much a season's output in the given league is worth relative to the same output in the
 * Premier League. Used to price players arriving from outside the Premier League, whose stat line
 * comes from whichever competition they actually played in.
 *
 * Returns DEFAULT_LEAGUE_STRENGTH_MULTIPLIER for a league we hold no opinion on, and for a null
 * league id — the provider omits the id on a handful of minor competitions, and an unidentifiable
 * league is exactly the case the pessimistic default exists for.
 */
export function getLeagueStrengthMultiplier(externalLeagueId: number | null): number {
  if (externalLeagueId === null) return DEFAULT_LEAGUE_STRENGTH_MULTIPLIER;
  return LEAGUE_STRENGTH_MULTIPLIER_BY_EXTERNAL_LEAGUE_ID[externalLeagueId] ?? DEFAULT_LEAGUE_STRENGTH_MULTIPLIER;
}

/**
 * Picks the stat line a player should be priced from, out of every competition the provider
 * reports for that season.
 *
 * The provider returns one entry per competition in arbitrary order — a Bundesliga regular can
 * lead with a U21 international qualifier, and a Championship regular with a League Cup cameo — so
 * taking the first entry prices players off whatever competition happens to sort first. Only
 * domestic leagues are eligible (cups and international tournaments are too short and too
 * self-selecting to price a season from), and among those the one with the most minutes is the
 * player's primary league.
 *
 * A player who moved countries mid-season has two eligible entries; taking the larger rather than
 * summing them keeps one stat line paired with one league-strength multiplier, which summing
 * across leagues of different strength would break.
 */
export function selectPrimaryDomesticLeagueEntry<T extends { leagueId: number | null; minutesPlayed: number }>(
  entries: readonly T[],
  domesticLeagueIds: ReadonlySet<number>,
): T | null {
  const domesticEntries = entries.filter(
    (entry) => entry.leagueId !== null && domesticLeagueIds.has(entry.leagueId),
  );
  if (domesticEntries.length === 0) return null;
  return domesticEntries.reduce((mostPlayed, entry) =>
    entry.minutesPlayed > mostPlayed.minutesPlayed ? entry : mostPlayed,
  );
}
