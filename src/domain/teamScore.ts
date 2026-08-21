import type { PlayerGameweekPoints } from "./playerScore";

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

/** A captain or vice-captain paired with their gameweek scoring, as the armband rule needs them. */
export interface ArmbandCandidate {
  playerId: string | null;
  /** Null when the player has no PlayerScore for the gameweek at all — no fixture, or their
   * match hasn't been scored yet. */
  gameweekPoints: PlayerGameweekPoints | null;
}

/**
 * Which player's points get counted a second time for the 2x armband bonus: the captain if they
 * played, otherwise the vice-captain if they played, otherwise nobody (fantasy_league_v1_design.txt
 * leaves the both-absent case with no further fallback in V1).
 *
 * Shared by calculateTeamScores — which writes the bonus into TeamScore.totalPoints — and the
 * squad builder's gameweek summary, which shows the bonus as its own line so a manager can
 * reconcile their per-player points against the team total. Kept in one place because a UI that
 * disagreed with the scorer about who holds the armband would be worse than showing nothing.
 */
export function resolveCaptainBonusPlayerId(captain: ArmbandCandidate, viceCaptain: ArmbandCandidate): string | null {
  if (captain.playerId && captain.gameweekPoints?.didAppear) return captain.playerId;
  if (viceCaptain.playerId && viceCaptain.gameweekPoints?.didAppear) return viceCaptain.playerId;
  return null;
}
