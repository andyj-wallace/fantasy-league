import type { GoalType } from "./shared";

/**
 * One goal in a Match, as imported from the provider's fixture event feed. This is raw
 * imported data in the same tier as PlayerMatchStat — it holds what happened, not points.
 * Its reason for existing is that PlayerMatchStat's aggregate counts cannot answer "which
 * goal decided this match", which the game-state bonus needs.
 */
export interface MatchGoalEvent {
  id: string;
  matchId: string;
  /** Null when the provider credits a scorer we have not imported as a Player yet. The event
   * must still occupy its place in the timeline or the running scoreline walk goes wrong. */
  scorerPlayerId: string | null;
  assistPlayerId: string | null;
  /** The club the goal counts FOR, already normalized for own goals — the provider credits an
   * own goal to the scorer's own club, which is the opposite of who benefits. */
  beneficiaryClub: string;
  goalType: GoalType;
  /** The provider's `time.elapsed`: 1-90, excluding added time. */
  elapsedMinute: number;
  /** The provider's `time.extra`: added time on top of elapsedMinute, 0 when there is none. */
  addedTimeMinute: number;
  /** Position in the provider's event list, used only to break ties between goals sharing a
   * minute so the chronological sort is deterministic. */
  sequenceIndex: number;
}
