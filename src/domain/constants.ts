import type { PlayerPosition } from "./shared";

/** Fixed salary cap every Team's budget is drawn down from (see fantasy_league_v1_design.txt). */
export const STARTING_SQUAD_BUDGET_IN_MILLIONS = 110;

/** Hard cap on banked free transfers, including postponed-match and gameweek-completion awards. */
export const MAX_BANKED_FREE_TRANSFER_COUNT = 8;

/** Points deducted for a transfer beyond the team's banked free transfers. */
export const POINTS_COST_PER_PAID_TRANSFER = 10;

/**
 * Flat per-position placeholder price assigned to a Player the first time the roster importer
 * sees them. Not real market pricing — that's deferred to a future task (see
 * docs/remaining-gaps-todo.md) once last-season per-player statistics are available to base it on.
 */
export const DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION: Record<PlayerPosition, number> = {
  GK: 4.5,
  DEF: 4.5,
  MID: 5.5,
  FWD: 5.5,
};
