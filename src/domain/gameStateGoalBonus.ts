import { GAME_STATE_GOAL_BASE_BONUS_POINTS, GOAL_TIMING_MULTIPLIER_BRACKETS, LATEST_GOAL_TIMING_MULTIPLIER } from "./constants";
import type { Match } from "./match";
import type { MatchGoalEvent } from "./matchGoalEvent";

/**
 * The goals that decided a Match, determined post-match from its full goal timeline.
 * winningGoal and losingGoal are the same event seen from either side and are both null in a
 * draw; equalizingGoal is non-null only in a drawn match that had at least one goal.
 */
export interface DecisiveGoals {
  winningGoal: MatchGoalEvent | null;
  equalizingGoal: MatchGoalEvent | null;
  losingGoal: MatchGoalEvent | null;
}

/** Whether a recipient is being rewarded for a decisive goal or charged for it. */
export type GameStateBonusDirection = "BONUS" | "PENALTY";

/** Minute a goal is treated as having been scored in for bracketing: a 45+2 first-half goal is
 * minute 47 and stays in the 1.0x bracket, while 90+3 is 93 and takes the 2.5x multiplier. */
export function goalEventToEffectiveMinute(goalEvent: MatchGoalEvent): number {
  return goalEvent.elapsedMinute + goalEvent.addedTimeMinute;
}

export function goalMinuteToTimingMultiplier(elapsedMinute: number, addedTimeMinute: number): number {
  const effectiveMinute = elapsedMinute + addedTimeMinute;
  for (const bracket of GOAL_TIMING_MULTIPLIER_BRACKETS) {
    if (effectiveMinute <= bracket.maximumEffectiveMinute) return bracket.multiplier;
  }
  return LATEST_GOAL_TIMING_MULTIPLIER;
}

/**
 * Rounds a multiplied bonus to the nearest integer by magnitude, then reapplies the sign.
 * Math.round alone rounds toward positive infinity on a .5, which would pay a 90+ minute
 * winner +13 while charging the loser only -12 for the very same goal.
 */
export function roundBonusPointsAwayFromZero(points: number): number {
  return Math.sign(points) * Math.round(Math.abs(points));
}

/** The final, ready-to-store points adjustment one recipient gets for one decisive goal.
 * Yields +/-5, 6, 8, 10, 13 across the five timing brackets. */
export function calculateGameStateBonusPoints(goalEvent: MatchGoalEvent, direction: GameStateBonusDirection): number {
  const signedBasePoints = direction === "BONUS" ? GAME_STATE_GOAL_BASE_BONUS_POINTS : -GAME_STATE_GOAL_BASE_BONUS_POINTS;
  const timingMultiplier = goalMinuteToTimingMultiplier(goalEvent.elapsedMinute, goalEvent.addedTimeMinute);
  return roundBonusPointsAwayFromZero(signedBasePoints * timingMultiplier);
}

/** Chronological order, with sequenceIndex breaking ties so two goals in the same minute keep
 * the order the provider reported them in. Does not mutate the caller's array. */
export function sortGoalEventsChronologically(goalEvents: MatchGoalEvent[]): MatchGoalEvent[] {
  return [...goalEvents].sort(
    (left, right) =>
      goalEventToEffectiveMinute(left) - goalEventToEffectiveMinute(right) || left.sequenceIndex - right.sequenceIndex,
  );
}

/**
 * Walks a Match's goal timeline and picks out the decisive goals, per the three scenarios in
 * fantasy_league_v1_design.txt. Returns all-null for a goalless match, an unfinished match
 * (no final score yet), or an unscored one.
 */
export function identifyDecisiveGoals(goalEvents: MatchGoalEvent[], match: Match): DecisiveGoals {
  const noDecisiveGoals: DecisiveGoals = { winningGoal: null, equalizingGoal: null, losingGoal: null };
  if (goalEvents.length === 0) return noDecisiveGoals;
  if (match.finalHomeScore === null || match.finalAwayScore === null) return noDecisiveGoals;

  const orderedGoals = sortGoalEventsChronologically(goalEvents);

  if (match.finalHomeScore === match.finalAwayScore) {
    // A goal moves the differential by exactly one, so a match that ends level was levelled by
    // its own final goal. Earlier ties that were subsequently broken do not qualify.
    return { winningGoal: null, equalizingGoal: orderedGoals[orderedGoals.length - 1]!, losingGoal: null };
  }

  const winningClub = match.finalHomeScore > match.finalAwayScore ? match.homeClub : match.awayClub;
  const concedingClub = winningClub === match.homeClub ? match.awayClub : match.homeClub;

  let winningClubGoalCount = 0;
  let concedingClubGoalCount = 0;
  let mostRecentGoAheadGoal: MatchGoalEvent | null = null;

  for (const goalEvent of orderedGoals) {
    const wasWinnerAheadBeforeGoal = winningClubGoalCount > concedingClubGoalCount;
    if (goalEvent.beneficiaryClub === winningClub) winningClubGoalCount += 1;
    else if (goalEvent.beneficiaryClub === concedingClub) concedingClubGoalCount += 1;
    else continue; // a club that isn't in this fixture — bad provider data, don't let it move the score
    if (!wasWinnerAheadBeforeGoal && winningClubGoalCount > concedingClubGoalCount) {
      mostRecentGoAheadGoal = goalEvent;
    }
  }

  // The last go-ahead goal is by construction the one after which the lead was never given up:
  // had the winner been pegged back, a later go-ahead goal would have overwritten this.
  return { winningGoal: mostRecentGoAheadGoal, equalizingGoal: null, losingGoal: mostRecentGoAheadGoal };
}
