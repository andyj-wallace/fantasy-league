import { STARTING_SQUAD_BUDGET_IN_MILLIONS } from "./constants";
import type { PlayerPosition, StartingFormation } from "./shared";

/** Squad rules from fantasy_league_v1_design.txt's "Squads" section. */
export const SQUAD_SIZE = 16;
export const STARTING_LINEUP_SIZE = 11;
export const REQUIRED_GOALKEEPER_COUNT = 2;
export const MAX_PLAYERS_PER_CLUB = 3;

/** Minimal player shape squad validation needs, so callers don't have to depend on the full Player type. */
export interface SquadValidationPlayer {
  position: PlayerPosition;
  club: string;
  priceInMillions: number;
}

/**
 * Checks the full 16-man squad: size, budget, goalkeeper count, per-club limit. Returns the
 * first violation found (in the order those rules are listed in the design doc), or null if the
 * squad is valid. Does not check the starting XI's formation — see deriveStartingFormation.
 */
export function validateSquadComposition(players: SquadValidationPlayer[]): string | null {
  if (players.length !== SQUAD_SIZE) {
    return `Squad must have exactly ${SQUAD_SIZE} players (got ${players.length})`;
  }

  const totalSpentInMillions = players.reduce((sum, player) => sum + player.priceInMillions, 0);
  if (totalSpentInMillions > STARTING_SQUAD_BUDGET_IN_MILLIONS) {
    return `Squad costs £${totalSpentInMillions}M, over the £${STARTING_SQUAD_BUDGET_IN_MILLIONS}M budget`;
  }

  const goalkeeperCount = players.filter((player) => player.position === "GK").length;
  if (goalkeeperCount !== REQUIRED_GOALKEEPER_COUNT) {
    return `Squad must have exactly ${REQUIRED_GOALKEEPER_COUNT} goalkeepers (got ${goalkeeperCount})`;
  }

  const countsByClub = new Map<string, number>();
  for (const player of players) {
    countsByClub.set(player.club, (countsByClub.get(player.club) ?? 0) + 1);
  }
  for (const [club, count] of countsByClub) {
    if (count > MAX_PLAYERS_PER_CLUB) {
      return `Squad has ${count} players from ${club}, over the limit of ${MAX_PLAYERS_PER_CLUB}`;
    }
  }

  return null;
}

/** The 7 formations valid for a starting XI in V1 (see fantasy_league_v1_design.txt) — each
 * name is itself its DEF-MID-FWD split, which deriveStartingFormation and
 * formationRequiredCounts below both parse rather than re-stating the mapping twice. */
export const VALID_STARTING_FORMATIONS: StartingFormation[] = [
  "3-4-3",
  "3-5-2",
  "4-3-3",
  "4-4-2",
  "4-5-1",
  "5-3-2",
  "5-4-1",
];

const FORMATION_BY_DEFENDER_MIDFIELDER_FORWARD_SHAPE: Record<string, StartingFormation> = Object.fromEntries(
  VALID_STARTING_FORMATIONS.map((formation) => [formation, formation]),
);

/** The exact per-position headcount a formation requires in the starting XI — the inverse of
 * deriveStartingFormation, used to drive squad-builder slot limits as the user assigns starters. */
export function formationRequiredCounts(formation: StartingFormation): Record<PlayerPosition, number> {
  const [defenderCount, midfielderCount, forwardCount] = formation.split("-").map(Number);
  return { GK: 1, DEF: defenderCount!, MID: midfielderCount!, FWD: forwardCount! };
}

/**
 * Derives the formation a starting XI actually forms, by shape (exactly 1 GK, plus the
 * DEF-MID-FWD split matched against the 7 valid formations in fantasy_league_v1_design.txt) —
 * not whatever a Team's stored `formation` field happens to say. Returns null if the starters
 * don't form any valid formation (wrong headcount, no/multiple goalkeepers, or a DEF-MID-FWD
 * split that isn't one of the 7 named formations even if individually within range).
 */
export function deriveStartingFormation(starters: { position: PlayerPosition }[]): StartingFormation | null {
  if (starters.length !== STARTING_LINEUP_SIZE) return null;
  if (starters.filter((player) => player.position === "GK").length !== 1) return null;

  const defenderCount = starters.filter((player) => player.position === "DEF").length;
  const midfielderCount = starters.filter((player) => player.position === "MID").length;
  const forwardCount = starters.filter((player) => player.position === "FWD").length;

  return FORMATION_BY_DEFENDER_MIDFIELDER_FORWARD_SHAPE[`${defenderCount}-${midfielderCount}-${forwardCount}`] ?? null;
}
