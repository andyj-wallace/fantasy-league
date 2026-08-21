import { describe, expect, it } from "vitest";
import { DEFAULT_LEAGUE_STRENGTH_MULTIPLIER } from "./constants";
import { getLeagueStrengthMultiplier, selectPrimaryDomesticLeagueEntry } from "./leagueStrength";

/** API-Football league ids, as verified against /leagues?type=league. */
const PREMIER_LEAGUE = 39;
const CHAMPIONSHIP = 40;
const BUNDESLIGA = 78;
const LIGUE_1 = 61;
const DFB_POKAL = 81;
const CHAMPIONS_LEAGUE = 2;
const UEFA_U21_QUALIFICATION = 850;

const DOMESTIC_LEAGUE_IDS = new Set([PREMIER_LEAGUE, CHAMPIONSHIP, BUNDESLIGA, LIGUE_1]);

function buildEntry(leagueId: number | null, minutesPlayed: number) {
  return { leagueId, minutesPlayed };
}

describe("getLeagueStrengthMultiplier", () => {
  it("treats the Premier League as the reference league", () => {
    expect(getLeagueStrengthMultiplier(PREMIER_LEAGUE)).toBe(1.0);
  });

  it("discounts a second-tier league below a top continental one", () => {
    expect(getLeagueStrengthMultiplier(CHAMPIONSHIP)).toBeLessThan(getLeagueStrengthMultiplier(BUNDESLIGA));
  });

  it("falls back to the pessimistic default for a league it holds no opinion on", () => {
    expect(getLeagueStrengthMultiplier(999_999)).toBe(DEFAULT_LEAGUE_STRENGTH_MULTIPLIER);
  });

  it("falls back to the default when the provider reports no league id", () => {
    expect(getLeagueStrengthMultiplier(null)).toBe(DEFAULT_LEAGUE_STRENGTH_MULTIPLIER);
  });
});

describe("selectPrimaryDomesticLeagueEntry", () => {
  it("picks the domestic league even when a cup or international entry sorts first", () => {
    // The real A. Amenda 2025 shape: a U21 qualifying campaign sorts ahead of a full Bundesliga
    // season, which is what made reading statistics[0] price players off the wrong competition.
    const entries = [
      buildEntry(UEFA_U21_QUALIFICATION, 810),
      buildEntry(DFB_POKAL, 0),
      buildEntry(BUNDESLIGA, 1685),
      buildEntry(CHAMPIONS_LEAGUE, 223),
    ];

    expect(selectPrimaryDomesticLeagueEntry(entries, DOMESTIC_LEAGUE_IDS)).toEqual(buildEntry(BUNDESLIGA, 1685));
  });

  it("prefers the domestic league with the most minutes when a player moved countries mid-season", () => {
    const entries = [buildEntry(LIGUE_1, 1400), buildEntry(BUNDESLIGA, 600)];

    expect(selectPrimaryDomesticLeagueEntry(entries, DOMESTIC_LEAGUE_IDS)).toEqual(buildEntry(LIGUE_1, 1400));
  });

  it("returns null when the player only appeared in cups and international competitions", () => {
    const entries = [buildEntry(UEFA_U21_QUALIFICATION, 810), buildEntry(CHAMPIONS_LEAGUE, 223)];

    expect(selectPrimaryDomesticLeagueEntry(entries, DOMESTIC_LEAGUE_IDS)).toBeNull();
  });

  it("returns null for a player with no reported competitions at all", () => {
    expect(selectPrimaryDomesticLeagueEntry([], DOMESTIC_LEAGUE_IDS)).toBeNull();
  });

  it("ignores entries the provider reports without a league id", () => {
    const entries = [buildEntry(null, 3000), buildEntry(CHAMPIONSHIP, 500)];

    expect(selectPrimaryDomesticLeagueEntry(entries, DOMESTIC_LEAGUE_IDS)).toEqual(buildEntry(CHAMPIONSHIP, 500));
  });
});
