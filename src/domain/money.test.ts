import { describe, expect, it } from "vitest";
import { roundToNearestTenthOfMillion } from "./money";
import { STARTING_SQUAD_BUDGET_IN_MILLIONS } from "./constants";

/** Simulates a `real` (float4) column round-trip, which is what Postgres actually stores. */
const asStoredFloat4 = (value: number) => Math.fround(value);

describe("roundToNearestTenthOfMillion", () => {
  it("recovers every £0.1M grid point in the money range after a float4 round-trip", () => {
    for (let tenths = 0; tenths <= STARTING_SQUAD_BUDGET_IN_MILLIONS * 10; tenths++) {
      const intended = tenths / 10;
      expect(roundToNearestTenthOfMillion(asStoredFloat4(intended))).toBe(intended);
    }
  });

  it("collapses the drift left by subtracting a spend from the cap", () => {
    // 110 - 64.1 is 45.900000000000006 in float64 — off the grid, and unequal to the 45.9 a
    // different sequence of adds and subtracts would land on.
    expect(STARTING_SQUAD_BUDGET_IN_MILLIONS - 64.1).not.toBe(45.9);
    expect(roundToNearestTenthOfMillion(STARTING_SQUAD_BUDGET_IN_MILLIONS - 64.1)).toBe(45.9);
  });

  it("is idempotent, so applying it at more than one boundary is harmless", () => {
    const once = roundToNearestTenthOfMillion(STARTING_SQUAD_BUDGET_IN_MILLIONS - 64.1);
    expect(roundToNearestTenthOfMillion(once)).toBe(once);
  });
});

/**
 * The bug this guards: a team that reached a given spend by saving a squad once, and a team that
 * reached the identical spend through a chain of transfers, accumulate float error differently.
 * The standings tiebreaker compares spend for exact equality, so unequal doubles split two teams
 * that should share a rank — and the wrong rank is then persisted into league_standings.
 */
describe("budget arithmetic paths converge", () => {
  const squadPrices = [13.0, 8.5, 7.5, 6.5, 5.5, 4.3, 4.7, 5.1, 6.2, 7.9, 3.4, 9.6, 8.8, 4.4, 5.6, 6.4];

  /** What setTeamRoster does: sum every price once, subtract from the cap. */
  function budgetAfterSquadSave(): number {
    const totalSpent = roundToNearestTenthOfMillion(squadPrices.reduce((sum, price) => sum + price, 0));
    return asStoredFloat4(roundToNearestTenthOfMillion(STARTING_SQUAD_BUDGET_IN_MILLIONS - totalSpent));
  }

  /** What makeTransfer does: adjust the stored budget one swap at a time, re-persisting each time. */
  function budgetAfterTransferChain(): number {
    let budget = budgetAfterSquadSave();
    for (const price of squadPrices) {
      // Swap a player out and an identically priced player back in — a no-op in game terms.
      budget = asStoredFloat4(roundToNearestTenthOfMillion(budget + price));
      budget = asStoredFloat4(roundToNearestTenthOfMillion(budget - price));
    }
    return budget;
  }

  it("produces the same spend whether the squad was saved once or transferred into", () => {
    const spentViaSave = roundToNearestTenthOfMillion(
      STARTING_SQUAD_BUDGET_IN_MILLIONS - roundToNearestTenthOfMillion(budgetAfterSquadSave()),
    );
    const spentViaTransfers = roundToNearestTenthOfMillion(
      STARTING_SQUAD_BUDGET_IN_MILLIONS - roundToNearestTenthOfMillion(budgetAfterTransferChain()),
    );

    expect(spentViaTransfers).toBe(spentViaSave);
  });
});
