/**
 * The points breakdown behind a PlayerScore's totalPoints, kept so a score can be explained
 * or audited without recomputing it from PlayerMatchStat (see "calculate once, store forever").
 */
export interface PlayerScoreBreakdown {
  appearancePoints: number;
  goalPoints: number;
  assistPoints: number;
  /** Always 0 for MID/FWD in V1 — only GK/DEF earn a clean sheet bonus. */
  cleanSheetPoints: number;
  savePoints: number;
  penaltyWonPoints: number;
  directFreeKickGoalBonusPoints: number;
  yellowCardPoints: number;
  redCardPoints: number;
  ownGoalPoints: number;
  penaltyConcededPoints: number;
}

/** A player's calculated fantasy points for one match, precomputed by calculatePlayerScores(matchId). */
export interface PlayerScore {
  id: string;
  playerId: string;
  matchId: string;
  gameweekId: string;
  breakdown: PlayerScoreBreakdown;
  totalPoints: number;
  calculatedAt: Date;
}
