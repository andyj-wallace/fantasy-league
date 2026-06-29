import type { MatchStatus } from "./shared";

/** A real-world Premier League fixture, imported from the football data provider. */
export interface Match {
  id: string;
  /** The football data provider's fixture ID; null until the importer first sees this fixture. */
  externalId: string | null;
  gameweekId: string;
  homeClub: string;
  awayClub: string;
  kickoffAt: Date;
  status: MatchStatus;
  /** Present once the match reaches COMPLETED. */
  finalHomeScore: number | null;
  finalAwayScore: number | null;
}

/**
 * Whether a club's players are locked right now — "Match Locking" in fantasy_league_v1_design.txt:
 * a player locks individually at the exact kickoff of their club's match, regardless of how that
 * match later resolves, and stays locked even after it finishes.
 */
export function isClubLocked(club: string, matches: { homeClub: string; awayClub: string; kickoffAt: Date }[], now: Date): boolean {
  return matches.some((match) => (match.homeClub === club || match.awayClub === club) && match.kickoffAt <= now);
}
