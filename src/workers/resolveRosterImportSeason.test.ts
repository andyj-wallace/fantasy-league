import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderLeagueSeason } from "./footballDataProvider";
import { resolveRosterImportSeason } from "./resolveRosterImportSeason";

/**
 * The regression test for the defect that motivated this guard: a roster import run against
 * season 2025 while 2026 was current, which imported the previous season's twenty clubs.
 */
function buildSeason(seasonYear: number, isCurrentSeason: boolean, coveragePlayers = true): ProviderLeagueSeason {
  return {
    seasonYear,
    isCurrentSeason,
    coveragePlayers,
    coverageFixturePlayerStats: coveragePlayers,
    coverageInjuries: true,
  };
}

const SEASONS = [buildSeason(2024, false), buildSeason(2025, false), buildSeason(2026, true, false)];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("resolveRosterImportSeason", () => {
  it("leads with the provider's current season when nothing is configured", () => {
    expect(resolveRosterImportSeason(SEASONS, null, null).seasonYear).toBe(2026);
  });

  it("refuses a configured season that is not the current one", () => {
    // The 2026-08-20 defect: FOOTBALL_DATA_SEASON_YEAR=2025 imported Wolves, Burnley and West Ham.
    expect(() => resolveRosterImportSeason(SEASONS, 2025, null)).toThrow(/current season is 2026/);
  });

  it("names the override flag in the refusal, so the operator is told the way through", () => {
    expect(() => resolveRosterImportSeason(SEASONS, 2025, null)).toThrow(/--season-override 2025/);
  });

  it("proceeds when the configured season agrees with the provider", () => {
    expect(resolveRosterImportSeason(SEASONS, 2026, null).seasonYear).toBe(2026);
  });

  it("imports a completed season when the operator explicitly overrides", () => {
    expect(resolveRosterImportSeason(SEASONS, 2025, 2025).seasonYear).toBe(2025);
  });

  it("lets the override stand even against a disagreeing environment variable", () => {
    // The flag is the operator speaking directly; the env var is ambient configuration.
    expect(resolveRosterImportSeason(SEASONS, 2024, 2025).seasonYear).toBe(2025);
  });

  it("carries the overridden season's own coverage flags, not the current season's", () => {
    // The gate on the paginated /players catch-all reads these, and 2026 and 2025 disagree.
    expect(resolveRosterImportSeason(SEASONS, null, 2025).coveragePlayers).toBe(true);
    expect(resolveRosterImportSeason(SEASONS, null, null).coveragePlayers).toBe(false);
  });

  it("rejects an override naming a season the provider does not hold", () => {
    expect(() => resolveRosterImportSeason(SEASONS, null, 1999)).toThrow(/does not hold/);
  });

  it("refuses to guess when the provider reports no current season", () => {
    expect(() => resolveRosterImportSeason([buildSeason(2025, false)], null, null)).toThrow(/no season this run can/);
  });
});
