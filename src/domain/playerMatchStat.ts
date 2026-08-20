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
  assists: number;
  savesCount: number;
  ownGoalsScored: number;
  penaltiesWon: number;
  penaltiesConceded: number;
  receivedYellowCard: boolean;
  receivedRedCard: boolean;
  /** Whether the player was in their club's starting XI (provider: `games.substitute === false`).
   * Scopes the losing-goal penalty, which applies to starting GKs/DEFs only. */
  wasInStartingLineup: boolean;
}
