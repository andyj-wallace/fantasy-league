const MIN_PRICE_IN_MILLIONS = 3;
const MAX_PRICE_IN_MILLIONS = 15;
const PRICE_RANGE_IN_MILLIONS = MAX_PRICE_IN_MILLIONS - MIN_PRICE_IN_MILLIONS;

/** Points ceiling used to normalize recent form — a high but realistic single-gameweek score.
 * Goals, assists, clean sheet, saves bonus in one match for a top performer lands around here. */
const FORM_POINTS_CEILING = 15;

/** Minimum scored matches required before the form signal influences the new price. Per design:
 * 3 is the minimum, 5 is the standard window. */
const MIN_MATCHES_FOR_FORM_SIGNAL = 3;

/** How many recent matches to consider for the form window (newest first). */
const FORM_WINDOW_MATCHES = 5;

export interface PlayerPricingInputs {
  /** Total fantasy points from the player's last FORM_WINDOW_MATCHES scored matches, newest first.
   * Naturally captures goals, assists, appearances, and card penalties via the scoring engine. */
  recentPointsNewestFirst: number[];
  /** Transfers in to this player over the last 30 days across all teams. */
  transfersIn: number;
  /** Transfers out from this player over the last 30 days across all teams. */
  transfersOut: number;
  /** Total number of teams across all leagues — the denominator for ownership and transfer scores. */
  totalTeams: number;
  /** How many teams currently roster this player. */
  teamsRostering: number;
}

/**
 * Derives a player's new market price from three signals: recent form (50%), transfer activity
 * (25%), and ownership percentage (25%). Clamped to [£3M, £15M], rounded to the nearest £0.1M.
 *
 * If fewer than MIN_MATCHES_FOR_FORM_SIGNAL scored matches exist (new or rarely-playing player),
 * the form weight redistributes equally to transfer activity and ownership rather than penalising
 * the player for a thin history.
 *
 * All constants and weights are named so they can be tuned independently — the formula is
 * intentionally subject to change and improvement as real data reveals how well each signal
 * predicts player value.
 */
export function calculateNewPriceInMillions(inputs: PlayerPricingInputs): number {
  const { recentPointsNewestFirst, transfersIn, transfersOut, totalTeams, teamsRostering } = inputs;
  const safeTeamCount = Math.max(totalTeams, 1);

  // Transfer activity: net transfers expressed as a fraction of total teams, centered so that
  // net-zero activity maps to 0.5 (neutral — no price movement from this signal alone).
  const netTransferRatio = (transfersIn - transfersOut) / safeTeamCount;
  const transferScore = Math.max(0, Math.min(1, (netTransferRatio + 1) / 2));

  // Ownership: fraction of all teams that currently roster this player.
  const ownershipScore = Math.min(teamsRostering / safeTeamCount, 1);

  // Recent form: average points per scored match over the last FORM_WINDOW_MATCHES matches,
  // normalized against FORM_POINTS_CEILING.
  const scoredMatches = recentPointsNewestFirst.slice(0, FORM_WINDOW_MATCHES);
  const hasEnoughFormData = scoredMatches.length >= MIN_MATCHES_FOR_FORM_SIGNAL;
  const formScore = hasEnoughFormData
    ? Math.min(
        scoredMatches.reduce((sum, pts) => sum + pts, 0) / scoredMatches.length / FORM_POINTS_CEILING,
        1,
      )
    : null;

  const composite =
    formScore !== null
      ? formScore * 0.5 + transferScore * 0.25 + ownershipScore * 0.25
      : transferScore * 0.5 + ownershipScore * 0.5;

  const rawPrice = MIN_PRICE_IN_MILLIONS + composite * PRICE_RANGE_IN_MILLIONS;
  return Math.max(MIN_PRICE_IN_MILLIONS, Math.min(MAX_PRICE_IN_MILLIONS, Math.round(rawPrice * 10) / 10));
}
