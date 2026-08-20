import type { PlayerPosition } from "./shared";

/** Fixed salary cap every Team's budget is drawn down from (see fantasy_league_v1_design.txt). */
export const STARTING_SQUAD_BUDGET_IN_MILLIONS = 110;

/** Hard cap on banked free transfers, including postponed-match and gameweek-completion awards. */
export const MAX_BANKED_FREE_TRANSFER_COUNT = 8;

/** Points deducted for a transfer beyond the team's banked free transfers. */
export const POINTS_COST_PER_PAID_TRANSFER = 10;

/** Hard cap on managers per league — joinLeague rejects once a league reaches this size. */
export const MAX_MANAGERS_PER_LEAGUE = 50;

/** System-wide Gameweek number after which no one may join any league (fantasy_league_v1_design.txt). */
export const GAMEWEEK_JOIN_CUTOFF_NUMBER = 25;

/** Feature toggle (decided 2026-07-18): commissionership transfer is fully implemented
 * (API + UI) but disabled for now — the commissioner is immutable for a league's entire
 * lifetime until this is turned back on. Gates both transferCommissionership's handler and
 * the League Settings page's Ownership section. */
export const IS_COMMISSIONERSHIP_TRANSFER_ENABLED = false;

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

/** Flat base bonus (or, negated, penalty) for a decisive goal, before the timing multiplier.
 * Deliberately below base goal points (+4 to +10) so the bonus stays a bonus. */
export const GAME_STATE_GOAL_BASE_BONUS_POINTS = 5;

/** Timing multipliers applied to the game-state bonus/penalty (never to base event points),
 * keyed by the highest effective minute in each bracket — see fantasy_league_v1_design.txt.
 * Anything past the last bracket uses LATEST_GOAL_TIMING_MULTIPLIER. */
export const GOAL_TIMING_MULTIPLIER_BRACKETS: readonly { maximumEffectiveMinute: number; multiplier: number }[] = [
  { maximumEffectiveMinute: 75, multiplier: 1.0 },
  { maximumEffectiveMinute: 80, multiplier: 1.2 },
  { maximumEffectiveMinute: 85, multiplier: 1.6 },
  { maximumEffectiveMinute: 90, multiplier: 2.0 },
];

/** Multiplier for any goal past 90 minutes — all added time and extra time. */
export const LATEST_GOAL_TIMING_MULTIPLIER = 2.5;

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
