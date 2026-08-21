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
 * sees them, and left in place by the pricing hydration script (hydratePlayerPricing.ts) for
 * anyone without enough previous-season data to price confidently — see
 * MINIMUM_PREVIOUS_SEASON_MINUTES_FOR_PRICING. Sitting at exactly this price is also how that
 * script recognises who is still waiting to be priced, so nothing else may write it.
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

/** The provider's id for the Premier League — the one real-world competition this game is built
 * around, and the reference league every other league's strength is measured against. */
export const PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID = 39;

/**
 * How much a season's output in each league is worth relative to the same output in the Premier
 * League, keyed by API-Football's league id. A player arriving from elsewhere is priced off the
 * league he actually played in, so 20 Championship goals must not price like 20 Premier League
 * goals — see leagueStrength.ts and docs/new-player-pricing.md.
 *
 * These are first-pass estimates, deliberately named and grouped so they can be tuned
 * independently once real arrival prices can be eyeballed. The ordering judgement worth knowing:
 * the strong continental leagues below sit *above* the Championship, on the view that their
 * output translates to the Premier League better than a second-tier English season does.
 */
export const LEAGUE_STRENGTH_MULTIPLIER_BY_EXTERNAL_LEAGUE_ID: Record<number, number> = {
  39: 1.0, // Premier League (England) — the reference league, by definition 1.0
  140: 0.85, // La Liga (Spain)
  135: 0.85, // Serie A (Italy)
  78: 0.85, // Bundesliga (Germany)
  61: 0.85, // Ligue 1 (France)
  88: 0.7, // Eredivisie (Netherlands)
  94: 0.7, // Primeira Liga (Portugal)
  203: 0.65, // Süper Lig (Turkey)
  144: 0.65, // Jupiler Pro League (Belgium)
  40: 0.6, // Championship (England)
  179: 0.6, // Premiership (Scotland)
  253: 0.55, // Major League Soccer (USA)
};

/** Applied to any domestic league not named in LEAGUE_STRENGTH_MULTIPLIER_BY_EXTERNAL_LEAGUE_ID.
 * Deliberately pessimistic: an unlisted league is one we have no opinion on, and underpricing an
 * unknown arrival is cheaper to correct than overpricing one. */
export const DEFAULT_LEAGUE_STRENGTH_MULTIPLIER = 0.5;
