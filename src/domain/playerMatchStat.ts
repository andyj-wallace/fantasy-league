/**
 * Raw per-player statistics for a single match, imported from the football data provider.
 * This is the unprocessed input to calculatePlayerScores(matchId); it holds counts, not points.
 */
export interface PlayerMatchStat {
  id: string;
  matchId: string;
  playerId: string;
  minutesPlayed: number;
  goalsScored: number;
  /** Of goalsScored, how many were scored directly from a free kick (scoring bonus). */
  directFreeKickGoalsScored: number;
  assists: number;
  savesCount: number;
  ownGoalsScored: number;
  penaltiesWon: number;
  penaltiesConceded: number;
  receivedYellowCard: boolean;
  receivedRedCard: boolean;
}
