/** A footballer's playing position, as used for squad/formation validation and scoring rules. */
export type PlayerPosition = "GK" | "DEF" | "MID" | "FWD";

/** The seven formations valid for a starting XI in V1 (see fantasy_league_v1_design.txt). */
export type StartingFormation =
  | "3-4-3"
  | "3-5-2"
  | "4-3-3"
  | "4-4-2"
  | "4-5-1"
  | "5-3-2"
  | "5-4-1";

/** Lifecycle status of a real-world fixture as reported by the football data provider. */
export type MatchStatus = "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "POSTPONED" | "DELAYED" | "INTERRUPTED";

/**
 * Lifecycle status of a gameweek, driving the GAMEWEEK_COMPLETED worker event.
 * COMPLETED requires every Match in the gameweek to have reached a final state — a gameweek
 * with one postponed Match stays IN_PROGRESS (not stuck, just not done) until that match is
 * replayed and scored, which re-triggers calculateTeamScores/updateStandings for this gameweek.
 */
export type GameweekStatus = "UPCOMING" | "LOCKED" | "IN_PROGRESS" | "COMPLETED";

/**
 * Cosmetic-only availability flag shown on player cards — does not affect roster rules,
 * scoring, or transfer eligibility. See "Player Availability Status" in Fantasy League
 * Architecture.txt for why this collapses the provider's injury/suspension data into 3 states.
 */
export type PlayerAvailabilityStatus = "AVAILABLE" | "OUT" | "QUESTIONABLE";
