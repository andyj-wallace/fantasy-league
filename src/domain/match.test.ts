import { describe, expect, it } from "vitest";
import { summarizeGameweekMatchProgress } from "./match";
import type { MatchStatus } from "./shared";

/** Progress is read off status alone, so the tests describe fixtures by status only. */
function matchesWithStatuses(...statuses: MatchStatus[]): { status: MatchStatus }[] {
  return statuses.map((status) => ({ status }));
}

describe("summarizeGameweekMatchProgress", () => {
  it("counts completed matches as played and reports the gameweek unfinished", () => {
    const progress = summarizeGameweekMatchProgress(
      matchesWithStatuses("COMPLETED", "COMPLETED", "IN_PROGRESS", "SCHEDULED"),
    );

    expect(progress).toEqual({ finalizedMatchCount: 2, totalMatchCount: 4, isGameweekFullyPlayed: false });
  });

  it("treats a voided match as final so it cannot hold the gameweek open forever", () => {
    // Mirrors gameweeksRepository.areAllMatchesCompleted, which gates TeamScores and standings.
    const progress = summarizeGameweekMatchProgress(matchesWithStatuses("COMPLETED", "VOIDED"));

    expect(progress.isGameweekFullyPlayed).toBe(true);
    expect(progress.finalizedMatchCount).toBe(2);
  });

  it("does not treat a postponed match as final — it is still expected to be played", () => {
    const progress = summarizeGameweekMatchProgress(matchesWithStatuses("COMPLETED", "POSTPONED"));

    expect(progress.isGameweekFullyPlayed).toBe(false);
    expect(progress.finalizedMatchCount).toBe(1);
  });

  it("reports an empty fixture list as not fully played rather than trivially complete", () => {
    // A gameweek with no imported fixtures hasn't finished; it hasn't started.
    expect(summarizeGameweekMatchProgress([])).toEqual({
      finalizedMatchCount: 0,
      totalMatchCount: 0,
      isGameweekFullyPlayed: false,
    });
  });
});
