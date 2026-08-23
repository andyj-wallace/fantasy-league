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

/** A team's scored position before it has been placed in the table — the input to ranking. */
export interface RankableTeamStanding {
  teamId: string;
  totalPoints: number;
  tiebreakerStats: LeagueStandingTiebreakerStats;
}

/**
 * Tiebreaker order from fantasy_league_v1_design.txt: points, then goals scored, then banked
 * transfers, then least spent. Returns 0 only when two teams are level on all four, which is a
 * shared rank — V1 has no further tiebreaker.
 */
export function compareRankableTeamStandings(a: RankableTeamStanding, b: RankableTeamStanding): number {
  return (
    b.totalPoints - a.totalPoints ||
    b.tiebreakerStats.goalsScoredBySelectedPlayers - a.tiebreakerStats.goalsScoredBySelectedPlayers ||
    b.tiebreakerStats.bankedFreeTransferCount - a.tiebreakerStats.bankedFreeTransferCount ||
    a.tiebreakerStats.totalSpentInMillions - b.tiebreakerStats.totalSpentInMillions
  );
}

/**
 * Orders teams into a finished league table, assigning each its rank. Teams level on points and
 * every tiebreaker share a rank, and the next team down takes the rank its row position implies
 * (two teams tied on 1 are both 1st, the third is 3rd) — standard competition ranking.
 *
 * Lives in the domain rather than in updateStandings because two callers need the identical
 * ordering: the worker that precomputes a scored gameweek's table, and the standings read that
 * builds the pre-season baseline where every team is on zero and only the tiebreakers separate them.
 */
export function rankTeamStandings(teams: RankableTeamStanding[]): (RankableTeamStanding & { rank: number })[] {
  const ordered = [...teams].sort(compareRankableTeamStandings);

  let rankOfCurrentGroup = 0;
  return ordered.map((team, index) => {
    const isTiedWithPrevious = index > 0 && compareRankableTeamStandings(ordered[index - 1]!, team) === 0;
    if (!isTiedWithPrevious) rankOfCurrentGroup = index + 1;
    return { ...team, rank: rankOfCurrentGroup };
  });
}
