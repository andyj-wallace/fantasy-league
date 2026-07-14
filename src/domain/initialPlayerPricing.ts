import {
  DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION,
  GOAL_POINTS_BY_POSITION,
  MAX_INITIAL_PRICE_IN_MILLIONS,
  MINIMUM_PREVIOUS_SEASON_MINUTES_FOR_PRICING,
  PRICE_PER_POINT_IN_MILLIONS,
} from "./constants";
import type { PlayerPosition } from "./shared";

/** Previous-season aggregate stat line needed to derive an initial price — a narrower shape than
 * PlayerSeasonStatistics (which also carries club/league/rating, not needed here). */
export interface InitialPlayerPricingInput {
  /** Current-roster position, not whatever position the provider listed last season — a player
   * can be re-classified between seasons, and squad budget validation checks the current one. */
  position: PlayerPosition;
  previousSeasonAppearances: number;
  previousSeasonMinutesPlayed: number;
  previousSeasonGoals: number;
  previousSeasonAssists: number;
  previousSeasonSaves: number;
  previousSeasonYellowCards: number;
  previousSeasonRedCards: number;
}

/**
 * Derives an initial price from an approximate previous-season points formula — mirrors
 * calculatePlayerScores.ts's per-component weights (appearance, goal-by-position, assist, saves,
 * cards) but omits clean sheets, penalties won/conceded, and own goals, since none of those are
 * derivable from season-aggregate data (they need match-by-match opponent/event data that the
 * bulk previous-season pull doesn't carry). A deliberate, accepted simplification for this first
 * pass — see docs/initial-player-pricing.md.
 *
 * Returns null when previous-season minutes fall below MINIMUM_PREVIOUS_SEASON_MINUTES_FOR_PRICING
 * — new signings, promoted-club debutants, true rookies — meaning the caller should leave the
 * flat DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION placeholder untouched.
 */
export function calculateInitialPriceInMillions(input: InitialPlayerPricingInput): number | null {
  if (
    input.previousSeasonAppearances === 0 ||
    input.previousSeasonMinutesPlayed < MINIMUM_PREVIOUS_SEASON_MINUTES_FOR_PRICING
  ) {
    return null;
  }

  const approxSeasonPoints =
    input.previousSeasonAppearances * 1 +
    input.previousSeasonGoals * GOAL_POINTS_BY_POSITION[input.position] +
    input.previousSeasonAssists * 3 +
    Math.floor(input.previousSeasonSaves / 3) -
    input.previousSeasonYellowCards * 1 -
    input.previousSeasonRedCards * 2;

  const avgPointsPerMatch = approxSeasonPoints / input.previousSeasonAppearances;
  const basePrice = DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION[input.position];
  const rawPrice = basePrice + avgPointsPerMatch * PRICE_PER_POINT_IN_MILLIONS;
  const clampedPrice = Math.max(basePrice, Math.min(MAX_INITIAL_PRICE_IN_MILLIONS, rawPrice));
  return Math.round(clampedPrice * 10) / 10;
}
