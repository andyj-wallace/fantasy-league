/** Player-card "recent form" rules from fantasy_league_squad_builder_flow_v1.txt. */
export const MINIMUM_MATCHES_FOR_RECENT_FORM = 3;
export const RECENT_FORM_MATCH_COUNT = 5;

/**
 * Takes a player's scored-match points newest-first and returns the recent-form slice (up to
 * the last 5), or null — meaning "Insufficient Data" — if fewer than 3 matches are available.
 */
export function deriveRecentFormPoints(pointsNewestFirst: number[]): number[] | null {
  if (pointsNewestFirst.length < MINIMUM_MATCHES_FOR_RECENT_FORM) return null;
  return pointsNewestFirst.slice(0, RECENT_FORM_MATCH_COUNT);
}
