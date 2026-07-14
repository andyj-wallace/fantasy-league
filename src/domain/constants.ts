import type { PlayerPosition } from "./shared";

/** Fixed salary cap every Team's budget is drawn down from (see fantasy_league_v1_design.txt). */
export const STARTING_SQUAD_BUDGET_IN_MILLIONS = 110;

/** Hard cap on banked free transfers, including postponed-match and gameweek-completion awards. */
export const MAX_BANKED_FREE_TRANSFER_COUNT = 8;

/** Points deducted for a transfer beyond the team's banked free transfers. */
export const POINTS_COST_PER_PAID_TRANSFER = 10;

/**
 * Flat per-position placeholder price assigned to a Player the first time the roster importer
 * sees them, and left in place by the initial-pricing hydration script
 * (hydrateInitialPlayerPricingOnce.ts) for anyone without enough previous-season data to price
 * confidently — see MINIMUM_PREVIOUS_SEASON_MINUTES_FOR_PRICING.
 */
export const DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION: Record<PlayerPosition, number> = {
  GK: 3,
  DEF: 4,
  MID: 4.5,
  FWD: 5.5,
};

/** Points per goal, by scorer position — fantasy_league_v1_design.txt. Shared by the live scoring
 * engine (calculatePlayerScores.ts) and the approximate previous-season pricing formula
 * (initialPlayerPricing.ts) so the two point tables can't drift apart. */
export const GOAL_POINTS_BY_POSITION: Record<PlayerPosition, number> = { GK: 10, DEF: 8, MID: 6, FWD: 4 };

/** How many of a position's placeholder price each approximate point of previous-season average
 * output adds — see initialPlayerPricing.ts. */
export const PRICE_PER_POINT_IN_MILLIONS = 1.0;

/** Ceiling on a hydration-computed initial price — keeps a small number of standout previous
 * seasons from running away with STARTING_SQUAD_BUDGET_IN_MILLIONS. */
export const MAX_INITIAL_PRICE_IN_MILLIONS = 13.0;

/** A player needs at least this many previous-season minutes before the hydration script trusts
 * their stat line enough to compute a price; below this (or no data at all) they keep the flat
 * DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION placeholder. ~5 full matches, matching
 * playerPricing.ts's FORM_WINDOW_MATCHES convention for "enough data to trust". */
export const MINIMUM_PREVIOUS_SEASON_MINUTES_FOR_PRICING = 450;
