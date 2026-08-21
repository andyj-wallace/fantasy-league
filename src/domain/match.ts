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

export interface GameweekMatchProgress {
  /** Matches that have reached a final state and can no longer change the gameweek's scoring. */
  finalizedMatchCount: number;
  totalMatchCount: number;
  /** True once every match is final — the same condition the worker checks before it writes
   * TeamScores and standings, so UI copy about when scores appear stays true to what gates them. */
  isGameweekFullyPlayed: boolean;
}

/**
 * How far through its fixtures a gameweek is. VOIDED counts as final alongside COMPLETED, mirroring
 * gameweeksRepository.areAllMatchesCompleted — a match that will never be played must not hold the
 * gameweek open forever. Takes a structural subset of Match so the frontend can pass the summaries
 * it gets from GET /gameweeks/current, whose dates arrive as strings.
 */
export function summarizeGameweekMatchProgress(matches: { status: MatchStatus }[]): GameweekMatchProgress {
  const finalizedMatchCount = matches.filter(
    (match) => match.status === "COMPLETED" || match.status === "VOIDED",
  ).length;
  return {
    finalizedMatchCount,
    totalMatchCount: matches.length,
    isGameweekFullyPlayed: matches.length > 0 && finalizedMatchCount === matches.length,
  };
}
