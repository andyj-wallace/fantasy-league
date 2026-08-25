import { describe, expect, it } from "vitest";
import { rankTeamStandings, type RankableTeamStanding } from "./leagueStanding";
import { roundToNearestTenthOfMillion } from "./money";
import { STARTING_SQUAD_BUDGET_IN_MILLIONS } from "./constants";

function buildRankable(teamId: string, overrides: Partial<RankableTeamStanding> = {}): RankableTeamStanding {
  return {
    teamId,
    totalPoints: 0,
    tiebreakerStats: { goalsScoredBySelectedPlayers: 0, bankedFreeTransferCount: 0, totalSpentInMillions: 0 },
    ...overrides,
  };
}

/** The ranking rule is shared by the standings worker and the unscored baseline the standings read
 * falls back to, so the tiebreaker order from fantasy_league_v1_design.txt is pinned here once. */
describe("rankTeamStandings", () => {
  it("ranks on total points first", () => {
    const ranked = rankTeamStandings([
      buildRankable("low", { totalPoints: 10 }),
      buildRankable("high", { totalPoints: 40 }),
      buildRankable("mid", { totalPoints: 25 }),
    ]);

    expect(ranked.map((row) => [row.teamId, row.rank])).toEqual([
      ["high", 1],
      ["mid", 2],
      ["low", 3],
    ]);
  });

  it("breaks a points tie on goals scored, then banked transfers, then least spent", () => {
    const byGoals = rankTeamStandings([
      buildRankable("fewer", {
        tiebreakerStats: { goalsScoredBySelectedPlayers: 3, bankedFreeTransferCount: 0, totalSpentInMillions: 0 },
      }),
      buildRankable("more", {
        tiebreakerStats: { goalsScoredBySelectedPlayers: 9, bankedFreeTransferCount: 0, totalSpentInMillions: 0 },
      }),
    ]);
    expect(byGoals.map((row) => row.teamId)).toEqual(["more", "fewer"]);

    const byBanked = rankTeamStandings([
      buildRankable("fewer", {
        tiebreakerStats: { goalsScoredBySelectedPlayers: 1, bankedFreeTransferCount: 1, totalSpentInMillions: 0 },
      }),
      buildRankable("more", {
        tiebreakerStats: { goalsScoredBySelectedPlayers: 1, bankedFreeTransferCount: 5, totalSpentInMillions: 0 },
      }),
    ]);
    expect(byBanked.map((row) => row.teamId)).toEqual(["more", "fewer"]);

    const bySpend = rankTeamStandings([
      buildRankable("spender", {
        tiebreakerStats: { goalsScoredBySelectedPlayers: 1, bankedFreeTransferCount: 1, totalSpentInMillions: 108 },
      }),
      buildRankable("saver", {
        tiebreakerStats: { goalsScoredBySelectedPlayers: 1, bankedFreeTransferCount: 1, totalSpentInMillions: 95 },
      }),
    ]);
    expect(bySpend.map((row) => row.teamId)).toEqual(["saver", "spender"]);
  });

  it("gives teams level on every tiebreaker a shared rank, and skips the ranks they consumed", () => {
    const ranked = rankTeamStandings([
      buildRankable("a", { totalPoints: 10 }),
      buildRankable("b", { totalPoints: 10 }),
      buildRankable("c", { totalPoints: 5 }),
    ]);

    // Two teams tied on first place means the next team down is third, not second.
    expect(ranked.map((row) => row.rank)).toEqual([1, 1, 3]);
    expect(ranked.find((row) => row.teamId === "c")?.rank).toBe(3);
  });

  it("puts a whole league of untouched teams on a shared rank 1 — the opening-day table", () => {
    const ranked = rankTeamStandings([buildRankable("a"), buildRankable("b"), buildRankable("c")]);

    expect(ranked.map((row) => row.rank)).toEqual([1, 1, 1]);
    expect(ranked.every((row) => row.totalPoints === 0)).toBe(true);
  });

  it("does not mutate the array it was given", () => {
    const teams = [buildRankable("low", { totalPoints: 1 }), buildRankable("high", { totalPoints: 99 })];

    rankTeamStandings(teams);

    expect(teams.map((row) => row.teamId)).toEqual(["low", "high"]);
  });
});

/**
 * Spend reaches the tiebreaker as a derived value — the cap minus a stored budget — and the two
 * handlers that derive it run different float arithmetic to get there. Without grid-snapping, two
 * teams on the same spend differ by ~1e-6 and are handed separate ranks instead of sharing one.
 */
describe("rankTeamStandings with float-derived spend", () => {
  function spendFromStoredBudget(remainingBudgetInMillions: number): number {
    return roundToNearestTenthOfMillion(STARTING_SQUAD_BUDGET_IN_MILLIONS - remainingBudgetInMillions);
  }

  it("shares a rank between teams whose equal spend was reached by different arithmetic paths", () => {
    // Both teams have spent exactly £99.5M. The squad-save path stores the budget as one
    // subtraction; the transfer path arrives at the same budget through a chain of swaps.
    const budgetViaSquadSave = roundToNearestTenthOfMillion(STARTING_SQUAD_BUDGET_IN_MILLIONS - 99.5);
    let budgetViaTransfers = STARTING_SQUAD_BUDGET_IN_MILLIONS;
    for (const price of [64.1, 12.3, 8.7, 6.2, 5.4, 2.8]) {
      budgetViaTransfers = roundToNearestTenthOfMillion(budgetViaTransfers - price);
    }

    expect(spendFromStoredBudget(budgetViaTransfers)).toBe(spendFromStoredBudget(budgetViaSquadSave));

    const ranked = rankTeamStandings([
      buildRankable("saver", {
        totalPoints: 50,
        tiebreakerStats: {
          goalsScoredBySelectedPlayers: 4,
          bankedFreeTransferCount: 1,
          totalSpentInMillions: spendFromStoredBudget(budgetViaSquadSave),
        },
      }),
      buildRankable("transferrer", {
        totalPoints: 50,
        tiebreakerStats: {
          goalsScoredBySelectedPlayers: 4,
          bankedFreeTransferCount: 1,
          totalSpentInMillions: spendFromStoredBudget(budgetViaTransfers),
        },
      }),
    ]);

    expect(ranked.map((row) => row.rank)).toEqual([1, 1]);
  });

  it("still separates teams that genuinely spent different amounts", () => {
    const ranked = rankTeamStandings([
      buildRankable("spent-more", {
        tiebreakerStats: {
          goalsScoredBySelectedPlayers: 0,
          bankedFreeTransferCount: 0,
          totalSpentInMillions: spendFromStoredBudget(10.4),
        },
      }),
      buildRankable("spent-less", {
        tiebreakerStats: {
          goalsScoredBySelectedPlayers: 0,
          bankedFreeTransferCount: 0,
          totalSpentInMillions: spendFromStoredBudget(10.5),
        },
      }),
    ]);

    expect(ranked.map((row) => [row.teamId, row.rank])).toEqual([
      ["spent-less", 1],
      ["spent-more", 2],
    ]);
  });
});
