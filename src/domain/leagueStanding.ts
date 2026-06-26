/**
 * Tiebreaker inputs in application order (see fantasy_league_v1_design.txt):
 * 1. goalsScoredBySelectedPlayers (most wins)
 * 2. bankedFreeTransferCount (most wins)
 * 3. totalSpentInMillions (least wins)
 * Ties remaining after all three are left tied (shared rank) — no further tiebreaker in V1.
 */
export interface LeagueStandingTiebreakerStats {
  goalsScoredBySelectedPlayers: number;
  bankedFreeTransferCount: number;
  totalSpentInMillions: number;
}

/** One row of a league's precomputed leaderboard for a gameweek, written by updateStandings(). */
export interface LeagueStanding {
  id: string;
  leagueId: string;
  gameweekId: string;
  teamId: string;
  /** Rank within the league as of this gameweek; tied teams share the same rank. */
  rank: number;
  /** Cumulative total points through this gameweek. */
  totalPoints: number;
  tiebreakerStats: LeagueStandingTiebreakerStats;
  calculatedAt: Date;
}
