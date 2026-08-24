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
 * Statuses meaning a fixture is under way and its outcome is still unknown to us — the rows the
 * live poller still owes an answer on.
 *
 * INTERRUPTED (the provider's SUSP/INT) sits beside IN_PROGRESS because it is *not* terminal: a
 * suspended match either resumes or is abandoned, and only a later provider answer can say which.
 * Leaving it out made an INTERRUPTED row unreachable by the poller forever — the same dead end
 * docs/stuck-live-match-reconciliation-plan.md was written to remove — and because
 * summarizeGameweekMatchProgress and gameweeksRepository.areAllMatchesCompleted count only
 * COMPLETED/VOIDED as final, that one row held its whole gameweek open (no free-transfer award, no
 * final standings) until the 12-hourly discovery pass healed it.
 *
 * Two places must agree on this rule: matchesRepository.findPotentiallyLive, which decides whether
 * such a row is handed to the live tick at all, and liveMatchPolling's reconciliation/pacing, which
 * decides whether to chase it. It lives here so they share one definition rather than mirroring a
 * status list across the db and worker layers.
 */
export const MATCH_STATUSES_UNDER_WAY_BUT_NOT_YET_RESOLVED: MatchStatus[] = ["IN_PROGRESS", "INTERRUPTED"];

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
