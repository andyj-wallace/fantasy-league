import type { PlayerPosition } from "./shared";

/**
 * Biographical detail for the player-detail page, sourced live from the provider's
 * /players/profiles endpoint on each request. Unlike PlayerScore/TeamScore, this is
 * presentational data outside the scoring pipeline, so it's never persisted — there's nothing
 * here to "calculate once, store forever".
 */
export interface PlayerProfile {
  externalId: string;
  firstName: string;
  lastName: string;
  age: number | null;
  birthDate: string | null;
  birthPlace: string | null;
  birthCountry: string | null;
  nationality: string | null;
  heightCm: number | null;
  weightKg: number | null;
  shirtNumber: number | null;
  photoUrl: string | null;
}

/**
 * One season's aggregated stat line for a Player at a single club, sourced live from the
 * provider's /players endpoint. Same not-persisted rationale as PlayerProfile.
 */
export interface PlayerSeasonStatistics {
  externalId: string;
  season: number;
  club: string;
  leagueName: string;
  /** API-Football's league id, needed to weight this stat line by league strength when pricing a
   * player who played outside the Premier League. Null on the few competitions the provider
   * reports without one. */
  leagueId: number | null;
  position: PlayerPosition | null;
  appearances: number;
  minutesPlayed: number;
  rating: number | null;
  goals: number;
  assists: number;
  saves: number;
  yellowCards: number;
  redCards: number;
}
