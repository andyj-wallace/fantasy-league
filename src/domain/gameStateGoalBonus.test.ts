import { describe, expect, it } from "vitest";
import {
  calculateGameStateBonusPoints,
  goalMinuteToTimingMultiplier,
  identifyDecisiveGoals,
  roundBonusPointsAwayFromZero,
} from "./gameStateGoalBonus";
import { buildMatch, buildMatchGoalEvent } from "../testing/fixtures";

/**
 * Unit tests for the game-state goal bonus core (docs/game-state-goal-bonus.md). Pure domain
 * logic, so no repository mocking is needed — every case is built from plain fixture objects.
 */

describe("goalMinuteToTimingMultiplier", () => {
  it("returns the multiplier for the interior of each of the five brackets", () => {
    expect(goalMinuteToTimingMultiplier(30, 0)).toBe(1.0);
    expect(goalMinuteToTimingMultiplier(78, 0)).toBe(1.2);
    expect(goalMinuteToTimingMultiplier(83, 0)).toBe(1.6);
    expect(goalMinuteToTimingMultiplier(88, 0)).toBe(2.0);
    expect(goalMinuteToTimingMultiplier(95, 0)).toBe(2.5);
  });

  it("switches multiplier at every bracket boundary, inclusive of the bracket's last minute", () => {
    expect(goalMinuteToTimingMultiplier(75, 0)).toBe(1.0);
    expect(goalMinuteToTimingMultiplier(76, 0)).toBe(1.2);
    expect(goalMinuteToTimingMultiplier(80, 0)).toBe(1.2);
    expect(goalMinuteToTimingMultiplier(81, 0)).toBe(1.6);
    expect(goalMinuteToTimingMultiplier(85, 0)).toBe(1.6);
    expect(goalMinuteToTimingMultiplier(86, 0)).toBe(2.0);
    expect(goalMinuteToTimingMultiplier(90, 0)).toBe(2.0);
    expect(goalMinuteToTimingMultiplier(91, 0)).toBe(2.5);
  });

  it("folds added time into the effective minute rather than treating it as a separate half", () => {
    // 45+2 is minute 47 of the match, nowhere near a late winner, so it must stay on 1.0x —
    // whereas 90+3 is minute 93 and takes the latest-goal multiplier.
    expect(goalMinuteToTimingMultiplier(45, 2)).toBe(1.0);
    expect(goalMinuteToTimingMultiplier(90, 3)).toBe(2.5);
  });
});

describe("calculateGameStateBonusPoints", () => {
  it("awards 5, 6, 8, 10 and 13 points across the five timing brackets", () => {
    const bonusPointsByMinute = [30, 78, 83, 88, 95].map((elapsedMinute) =>
      calculateGameStateBonusPoints(
        buildMatchGoalEvent({ matchId: "match-1", beneficiaryClub: "Home FC", elapsedMinute }),
        "BONUS",
      ),
    );
    expect(bonusPointsByMinute).toEqual([5, 6, 8, 10, 13]);
  });

  it("charges penalties that exactly mirror the bonuses, including -13 rather than -12 past 90", () => {
    // Regression guard for the asymmetric-Math.round bug: Math.round(-12.5) is -12 in JS, which
    // would pay a 90+ minute winner +13 while charging the conceding side only -12 for the same goal.
    const penaltyPointsByMinute = [30, 78, 83, 88, 95].map((elapsedMinute) =>
      calculateGameStateBonusPoints(
        buildMatchGoalEvent({ matchId: "match-1", beneficiaryClub: "Home FC", elapsedMinute }),
        "PENALTY",
      ),
    );
    expect(penaltyPointsByMinute).toEqual([-5, -6, -8, -10, -13]);
  });
});

describe("roundBonusPointsAwayFromZero", () => {
  it("rounds a .5 magnitude away from zero in both directions", () => {
    expect(roundBonusPointsAwayFromZero(12.5)).toBe(13);
    expect(roundBonusPointsAwayFromZero(-12.5)).toBe(-13);
  });
});

describe("identifyDecisiveGoals", () => {
  it("returns no decisive goals for a goalless match", () => {
    const goallessMatch = buildMatch({ finalHomeScore: 0, finalAwayScore: 0 });

    expect(identifyDecisiveGoals([], goallessMatch)).toEqual({
      winningGoal: null,
      equalizingGoal: null,
      losingGoal: null,
    });
  });

  it("returns no decisive goals while the match has no final score yet", () => {
    const unfinishedMatch = buildMatch({ status: "IN_PROGRESS", finalHomeScore: null, finalAwayScore: null });
    const goalSoFar = buildMatchGoalEvent({
      matchId: unfinishedMatch.id,
      beneficiaryClub: unfinishedMatch.homeClub,
      elapsedMinute: 20,
    });

    expect(identifyDecisiveGoals([goalSoFar], unfinishedMatch)).toEqual({
      winningGoal: null,
      equalizingGoal: null,
      losingGoal: null,
    });
  });

  it("treats the only goal of a 1-0 as both the winning goal and the losing goal", () => {
    const match = buildMatch({ finalHomeScore: 1, finalAwayScore: 0 });
    const onlyGoal = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 55,
    });

    const decisiveGoals = identifyDecisiveGoals([onlyGoal], match);

    expect(decisiveGoals.winningGoal).toBe(onlyGoal);
    expect(decisiveGoals.losingGoal).toBe(onlyGoal);
    expect(decisiveGoals.equalizingGoal).toBeNull();
  });

  it("picks the goal that retook the lead, not the first one, when the lead was pegged back", () => {
    const match = buildMatch({ finalHomeScore: 2, finalAwayScore: 1 });
    const homeOpener = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 10,
      sequenceIndex: 0,
    });
    const awayEqualizer = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.awayClub,
      elapsedMinute: 40,
      sequenceIndex: 1,
    });
    const homeWinner = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 87,
      sequenceIndex: 2,
    });

    const decisiveGoals = identifyDecisiveGoals([homeOpener, awayEqualizer, homeWinner], match);

    expect(decisiveGoals.winningGoal).toBe(homeWinner);
    expect(decisiveGoals.losingGoal).toBe(homeWinner);
    expect(decisiveGoals.equalizingGoal).toBeNull();
  });

  it("picks the go-ahead goal, not the final goal, in a 3-1 win where the winner conceded first", () => {
    const match = buildMatch({ finalHomeScore: 3, finalAwayScore: 1 });
    const awayOpener = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.awayClub,
      elapsedMinute: 5,
      sequenceIndex: 0,
    });
    const homeLeveller = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 25,
      sequenceIndex: 1,
    });
    const homeGoAheadGoal = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 60,
      sequenceIndex: 2,
    });
    const homeConsolationThirdGoal = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 89,
      sequenceIndex: 3,
    });

    const decisiveGoals = identifyDecisiveGoals(
      [awayOpener, homeLeveller, homeGoAheadGoal, homeConsolationThirdGoal],
      match,
    );

    expect(decisiveGoals.winningGoal).toBe(homeGoAheadGoal);
    expect(decisiveGoals.losingGoal).toBe(homeGoAheadGoal);
  });

  it("treats the last goal of a 2-2 draw as the equalizing goal, with no winning or losing goal", () => {
    const match = buildMatch({ finalHomeScore: 2, finalAwayScore: 2 });
    const homeOpener = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 12,
      sequenceIndex: 0,
    });
    const awayFirstEqualizer = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.awayClub,
      elapsedMinute: 34,
      sequenceIndex: 1,
    });
    const homeSecondGoal = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 70,
      sequenceIndex: 2,
    });
    const awayFinalEqualizer = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.awayClub,
      elapsedMinute: 90,
      addedTimeMinute: 4,
      sequenceIndex: 3,
    });

    const decisiveGoals = identifyDecisiveGoals(
      [homeOpener, awayFirstEqualizer, homeSecondGoal, awayFinalEqualizer],
      match,
    );

    expect(decisiveGoals.equalizingGoal).toBe(awayFinalEqualizer);
    expect(decisiveGoals.winningGoal).toBeNull();
    expect(decisiveGoals.losingGoal).toBeNull();
  });

  it("does not reward a mid-match equalizer that was later broken (final-equalizer-only rule)", () => {
    const match = buildMatch({ finalHomeScore: 2, finalAwayScore: 1 });
    const homeOpener = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 15,
      sequenceIndex: 0,
    });
    const awayMidMatchEqualizer = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.awayClub,
      elapsedMinute: 50,
      sequenceIndex: 1,
    });
    const homeWinner = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 80,
      sequenceIndex: 2,
    });

    const decisiveGoals = identifyDecisiveGoals([homeOpener, awayMidMatchEqualizer, homeWinner], match);

    expect(decisiveGoals.equalizingGoal).toBeNull();
    expect(decisiveGoals.winningGoal).toBe(homeWinner);
  });

  it("credits a decisive own goal to the club that did not score it", () => {
    // The provider reports an own goal against the scorer's own club; beneficiaryClub arrives
    // already normalized, so the walk must read the beneficiary and never the scorer's side.
    const match = buildMatch({ finalHomeScore: 1, finalAwayScore: 0 });
    const ownGoalByAwayPlayer = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      goalType: "OWN_GOAL",
      elapsedMinute: 66,
    });

    const decisiveGoals = identifyDecisiveGoals([ownGoalByAwayPlayer], match);

    expect(decisiveGoals.winningGoal).toBe(ownGoalByAwayPlayer);
    expect(decisiveGoals.winningGoal?.beneficiaryClub).toBe(match.homeClub);
    expect(decisiveGoals.winningGoal?.beneficiaryClub).not.toBe(match.awayClub);
    expect(decisiveGoals.losingGoal).toBe(ownGoalByAwayPlayer);
  });

  it("orders two goals scored in the same minute by sequenceIndex", () => {
    // Both late goals land on minute 90, so only the provider's reported order distinguishes
    // "equalized then won it" (winner = the minute-90 home goal) from "won it, then conceded a
    // consolation" (winner = the opener) — and the array is deliberately passed out of order.
    const match = buildMatch({ finalHomeScore: 2, finalAwayScore: 1 });
    const homeOpener = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 20,
      sequenceIndex: 0,
    });
    const awayEqualizerAtNinety = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.awayClub,
      elapsedMinute: 90,
      sequenceIndex: 1,
    });
    const homeWinnerAtNinety = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 90,
      sequenceIndex: 2,
    });

    const decisiveGoals = identifyDecisiveGoals([homeWinnerAtNinety, awayEqualizerAtNinety, homeOpener], match);

    expect(decisiveGoals.winningGoal).toBe(homeWinnerAtNinety);

    const homeGoalAtNinetyReportedFirst = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.homeClub,
      elapsedMinute: 90,
      sequenceIndex: 1,
    });
    const awayGoalAtNinetyReportedSecond = buildMatchGoalEvent({
      matchId: match.id,
      beneficiaryClub: match.awayClub,
      elapsedMinute: 90,
      sequenceIndex: 2,
    });

    const decisiveGoalsWithSequenceSwapped = identifyDecisiveGoals(
      [homeOpener, awayGoalAtNinetyReportedSecond, homeGoalAtNinetyReportedFirst],
      match,
    );

    // With the same-minute order reversed the home side never trailed, so the opener stands as
    // the goal that won it — proof that sequenceIndex, not array order, drives the walk.
    expect(decisiveGoalsWithSequenceSwapped.winningGoal).toBe(homeOpener);
  });
});
