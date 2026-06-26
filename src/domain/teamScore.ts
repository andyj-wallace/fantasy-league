/** A team's calculated fantasy total for one gameweek, precomputed by calculateTeamScores(gameweek). */
export interface TeamScore {
  id: string;
  teamId: string;
  gameweekId: string;
  /** Snapshot of who held the captain bonus when this was calculated (captain, or vice-captain on fallback). */
  captainBonusPlayerId: string | null;
  totalPoints: number;
  calculatedAt: Date;
}
