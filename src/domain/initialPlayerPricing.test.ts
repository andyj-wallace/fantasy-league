import { describe, expect, it } from "vitest";
import { DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION } from "./constants";
import { calculateInitialPriceInMillions, type InitialPlayerPricingInput } from "./initialPlayerPricing";

/**
 * Unit tests for the pre-season initial-pricing formula (docs/initial-player-pricing.md). Pure
 * function, no repository mocking needed.
 */
function buildInput(overrides: Partial<InitialPlayerPricingInput> = {}): InitialPlayerPricingInput {
  return {
    position: "MID",
    previousSeasonAppearances: 30,
    previousSeasonMinutesPlayed: 2700,
    previousSeasonGoals: 0,
    previousSeasonAssists: 0,
    previousSeasonSaves: 0,
    previousSeasonYellowCards: 0,
    previousSeasonRedCards: 0,
    ...overrides,
  };
}

describe("calculateInitialPriceInMillions — insufficient data", () => {
  it("returns null when previous-season minutes fall below the threshold", () => {
    const input = buildInput({ previousSeasonAppearances: 5, previousSeasonMinutesPlayed: 449 });
    expect(calculateInitialPriceInMillions(input)).toBeNull();
  });

  it("returns null for zero appearances even if minutes are non-zero (defensive)", () => {
    const input = buildInput({ previousSeasonAppearances: 0, previousSeasonMinutesPlayed: 0 });
    expect(calculateInitialPriceInMillions(input)).toBeNull();
  });

  it("returns a price at exactly the minutes threshold", () => {
    const input = buildInput({ previousSeasonAppearances: 5, previousSeasonMinutesPlayed: 450 });
    expect(calculateInitialPriceInMillions(input)).not.toBeNull();
  });
});

describe("calculateInitialPriceInMillions — position-weighted goal points", () => {
  it("lifts price above a GK's base more than a FWD's base for the same goal tally", () => {
    // GK/DEF placeholder bases are much lower than MID/FWD's, so comparing absolute prices would
    // conflate the base-price gap with the goal-weight gap — compare the lift over each
    // position's own base instead, which isolates GOAL_POINTS_BY_POSITION's effect (GK:10 > FWD:4).
    const stats = { previousSeasonAppearances: 30, previousSeasonMinutesPlayed: 2700, previousSeasonGoals: 2 };
    const gkPrice = calculateInitialPriceInMillions(buildInput({ position: "GK", ...stats }));
    const fwdPrice = calculateInitialPriceInMillions(buildInput({ position: "FWD", ...stats }));

    expect(gkPrice).not.toBeNull();
    expect(fwdPrice).not.toBeNull();
    expect(gkPrice! - 3).toBeGreaterThan(fwdPrice! - 5.5); // lift over GK base vs. lift over FWD base
  });

  it("a prolific FWD still prices above the flat FWD placeholder", () => {
    const input = buildInput({ position: "FWD", previousSeasonGoals: 20, previousSeasonAssists: 10 });
    const price = calculateInitialPriceInMillions(input);
    expect(price).not.toBeNull();
    expect(price!).toBeGreaterThan(5.5); // FWD placeholder base
  });
});

describe("calculateInitialPriceInMillions — clamping", () => {
  it("never prices below the position's placeholder base, even with heavy card penalties", () => {
    const input = buildInput({
      position: "DEF",
      previousSeasonAppearances: 20,
      previousSeasonMinutesPlayed: 1800,
      previousSeasonYellowCards: 15,
      previousSeasonRedCards: 3,
    });
    const price = calculateInitialPriceInMillions(input);
    expect(price).not.toBeNull();
    expect(price!).toBeGreaterThanOrEqual(4); // DEF placeholder base
  });

  it("clamps at MAX_INITIAL_PRICE_IN_MILLIONS for an extreme stat line", () => {
    const input = buildInput({
      position: "FWD",
      previousSeasonAppearances: 38,
      previousSeasonMinutesPlayed: 3420,
      previousSeasonGoals: 40,
      previousSeasonAssists: 30,
    });
    expect(calculateInitialPriceInMillions(input)).toBe(13);
  });
});

describe("calculateInitialPriceInMillions — rounding", () => {
  it("rounds the result to the nearest £0.1M", () => {
    const input = buildInput({ position: "MID", previousSeasonGoals: 3, previousSeasonAssists: 4 });
    const price = calculateInitialPriceInMillions(input)!;
    expect(Math.round(price * 10) / 10).toBe(price);
  });
});

describe("calculateInitialPriceInMillions — league strength", () => {
  const productiveSeason = { position: "FWD" as const, previousSeasonGoals: 15, previousSeasonAssists: 6 };

  it("defaults to no adjustment, so a Premier League caller needs no extra argument", () => {
    const unspecified = calculateInitialPriceInMillions(buildInput(productiveSeason));
    const explicitlyUnadjusted = calculateInitialPriceInMillions(
      buildInput({ ...productiveSeason, leagueStrengthMultiplier: 1 }),
    );
    expect(unspecified).toBe(explicitlyUnadjusted);
  });

  it("prices an identical stat line lower in a weaker league", () => {
    const premierLeaguePrice = calculateInitialPriceInMillions(buildInput(productiveSeason))!;
    const championshipPrice = calculateInitialPriceInMillions(
      buildInput({ ...productiveSeason, leagueStrengthMultiplier: 0.6 }),
    )!;
    expect(championshipPrice).toBeLessThan(premierLeaguePrice);
  });

  it("never discounts a player below their position's placeholder floor", () => {
    // A punishing multiplier must shrink the earned portion of the price, not the floor itself.
    const price = calculateInitialPriceInMillions(
      buildInput({ position: "GK", previousSeasonYellowCards: 12, leagueStrengthMultiplier: 0.05 }),
    )!;
    expect(price).toBeGreaterThanOrEqual(DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION.GK);
  });

  it("still leaves a sub-threshold season unpriced regardless of league", () => {
    const input = buildInput({
      previousSeasonAppearances: 5,
      previousSeasonMinutesPlayed: 449,
      leagueStrengthMultiplier: 1,
    });
    expect(calculateInitialPriceInMillions(input)).toBeNull();
  });
});
