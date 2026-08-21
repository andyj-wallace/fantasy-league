import { describe, expect, it } from "vitest";
import { PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID } from "./constants";
import {
  MEASURED_HYDRATION_CALL_COST_ESTIMATES,
  planUnpricedPlayerHydration,
  type UnpricedPlayerHydrationCandidate,
} from "./hydrationCostModel";

const CHAMPIONSHIP = 40;

let nextPlayerNumber = 1;

function buildCandidates(
  count: number,
  currentClubName: string,
  expectedPreviousSeasonLeagueId: number | null = null,
): UnpricedPlayerHydrationCandidate[] {
  return Array.from({ length: count }, () => ({
    playerExternalId: String(nextPlayerNumber++),
    currentClubName,
    expectedPreviousSeasonLeagueId,
  }));
}

describe("planUnpricedPlayerHydration — per-club bulk vs individual lookups", () => {
  it("looks players up individually while the club is cheaper one at a time", () => {
    // Two players at 1 call each ties the 2-page club pull, and a tie is not a reason to bulk.
    const plan = planUnpricedPlayerHydration(buildCandidates(2, "Brentford"));

    expect(plan.clubBulkPulls).toEqual([]);
    expect(plan.individualLookupPlayerExternalIds).toHaveLength(2);
    expect(plan.projectedTotalCallCost).toBe(2);
  });

  it("bulk-pulls the club as soon as that is strictly cheaper", () => {
    const plan = planUnpricedPlayerHydration(buildCandidates(3, "Brentford"));

    expect(plan.clubBulkPulls.map((pull) => pull.clubName)).toEqual(["Brentford"]);
    expect(plan.individualLookupPlayerExternalIds).toEqual([]);
    expect(plan.projectedTotalCallCost).toBe(2);
  });

  it("turns a promoted club's whole squad into two calls", () => {
    // The case the per-club path exists for: 25 players who were all at the same club last season.
    const plan = planUnpricedPlayerHydration(buildCandidates(25, "Coventry"));

    expect(plan.projectedTotalCallCost).toBe(2);
    expect(plan.clubBulkPulls[0]?.playerExternalIds).toHaveLength(25);
  });

  it("does not re-propose a club an earlier run already bulk-pulled", () => {
    // Whoever that pull could resolve was resolved then; anyone still unpriced was elsewhere last
    // season, so re-paying for the same pages buys nothing.
    const plan = planUnpricedPlayerHydration(buildCandidates(25, "Coventry"), MEASURED_HYDRATION_CALL_COST_ESTIMATES, {
      clubNames: new Set(["Coventry"]),
      leagueIds: new Set(),
    });

    expect(plan.clubBulkPulls).toEqual([]);
    expect(plan.projectedTotalCallCost).toBe(25);
  });
});

describe("planUnpricedPlayerHydration — league bulk", () => {
  it("prefers one Premier League pull over seventeen separate club pulls", () => {
    // The pre-season shape: most of the current roster played in the Premier League last season.
    // 17 clubs at 2 pages each is 34; the league-wide pull is 28.
    const candidates = Array.from({ length: 17 }, (_, clubIndex) =>
      buildCandidates(3, `PL Club ${clubIndex}`, PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID),
    ).flat();

    const plan = planUnpricedPlayerHydration(candidates);

    expect(plan.leagueBulkPulls.map((pull) => pull.leagueId)).toEqual([PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID]);
    expect(plan.clubBulkPulls).toEqual([]);
    expect(plan.projectedTotalCallCost).toBe(28);
  });

  it("leaves a handful of Premier League clubs to per-club pulls instead", () => {
    // Five clubs at 2 pages is 10 — a 28-page league pull to save nothing would be the wrong trade.
    const candidates = Array.from({ length: 5 }, (_, clubIndex) =>
      buildCandidates(3, `PL Club ${clubIndex}`, PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID),
    ).flat();

    const plan = planUnpricedPlayerHydration(candidates);

    expect(plan.leagueBulkPulls).toEqual([]);
    expect(plan.clubBulkPulls).toHaveLength(5);
    expect(plan.projectedTotalCallCost).toBe(10);
  });

  it("keeps a scattered long tail on individual lookups", () => {
    // The transfer-window shape: single arrivals at many clubs, from many leagues. Neither bulk
    // path can be justified — no club has enough of them, and no league is worth 28 pages.
    const candidates = Array.from({ length: 30 }, (_, index) =>
      buildCandidates(1, `Club ${index}`, 100 + index),
    ).flat();

    const plan = planUnpricedPlayerHydration(candidates);

    expect(plan.leagueBulkPulls).toEqual([]);
    expect(plan.clubBulkPulls).toEqual([]);
    expect(plan.individualLookupPlayerExternalIds).toHaveLength(30);
    expect(plan.projectedTotalCallCost).toBe(30);
  });

  it("never proposes a league the provider has no league-wide pull for", () => {
    // 60 Championship players across 30 clubs would be worth a league pull at 48 pages, but
    // fetchAllPlayerSeasonStatistics only speaks Premier League — so the Championship carries no
    // cost estimate and must not appear in a plan the executor cannot run.
    const candidates = Array.from({ length: 30 }, (_, index) =>
      buildCandidates(2, `Club ${index}`, CHAMPIONSHIP),
    ).flat();

    const plan = planUnpricedPlayerHydration(candidates);

    expect(plan.leagueBulkPulls).toEqual([]);
    expect(plan.individualLookupPlayerExternalIds).toHaveLength(60);
  });

  it("ignores players with no expected source league when weighing a league pull", () => {
    // A league bulk must never be justified by players it might not contain: 17 clubs' worth of
    // unknowns look like the Premier League case by headcount, but nothing says they are in it.
    const candidates = Array.from({ length: 17 }, (_, clubIndex) => buildCandidates(3, `Club ${clubIndex}`, null)).flat();

    const plan = planUnpricedPlayerHydration(candidates);

    expect(plan.leagueBulkPulls).toEqual([]);
    expect(plan.clubBulkPulls).toHaveLength(17);
    expect(plan.projectedTotalCallCost).toBe(34);
  });

  it("mixes a league pull with per-club pulls for the clubs it does not cover", () => {
    const returningPremierLeaguePlayers = Array.from({ length: 17 }, (_, clubIndex) =>
      buildCandidates(3, `PL Club ${clubIndex}`, PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID),
    ).flat();
    const promotedClubSquad = buildCandidates(25, "Coventry", CHAMPIONSHIP);

    const plan = planUnpricedPlayerHydration([...returningPremierLeaguePlayers, ...promotedClubSquad]);

    expect(plan.leagueBulkPulls.map((pull) => pull.leagueId)).toEqual([PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID]);
    expect(plan.clubBulkPulls.map((pull) => pull.clubName)).toEqual(["Coventry"]);
    expect(plan.projectedTotalCallCost).toBe(30);
  });

  it("does not re-propose a league an earlier run already bulk-pulled", () => {
    const candidates = Array.from({ length: 17 }, (_, clubIndex) =>
      buildCandidates(3, `PL Club ${clubIndex}`, PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID),
    ).flat();

    const plan = planUnpricedPlayerHydration(candidates, MEASURED_HYDRATION_CALL_COST_ESTIMATES, {
      clubNames: new Set(),
      leagueIds: new Set([PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID]),
    });

    expect(plan.leagueBulkPulls).toEqual([]);
    expect(plan.clubBulkPulls).toHaveLength(17);
  });
});

describe("planUnpricedPlayerHydration — projection arithmetic", () => {
  it("costs nothing for an empty cohort", () => {
    const plan = planUnpricedPlayerHydration([]);

    expect(plan).toEqual({
      leagueBulkPulls: [],
      clubBulkPulls: [],
      individualLookupPlayerExternalIds: [],
      projectedTotalCallCost: 0,
    });
  });

  it("accounts for every candidate exactly once", () => {
    const candidates = [
      ...Array.from({ length: 17 }, (_, i) => buildCandidates(3, `PL Club ${i}`, PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID)).flat(),
      ...buildCandidates(25, "Coventry", CHAMPIONSHIP),
      ...buildCandidates(1, "Arsenal", null),
    ];

    const plan = planUnpricedPlayerHydration(candidates);
    const covered = [
      ...plan.leagueBulkPulls.flatMap((pull) => pull.playerExternalIds),
      ...plan.clubBulkPulls.flatMap((pull) => pull.playerExternalIds),
      ...plan.individualLookupPlayerExternalIds,
    ];

    expect(covered.length).toBe(candidates.length);
    expect(new Set(covered).size).toBe(candidates.length);
  });

  it("plans the same cohort identically regardless of the order it arrives in", () => {
    const candidates = [
      ...buildCandidates(4, "Sunderland", CHAMPIONSHIP),
      ...buildCandidates(3, "Leeds", CHAMPIONSHIP),
      ...buildCandidates(1, "Arsenal", PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID),
    ];

    const inOrder = planUnpricedPlayerHydration(candidates);
    const reversed = planUnpricedPlayerHydration([...candidates].reverse());

    expect(reversed.clubBulkPulls.map((pull) => pull.clubName)).toEqual(inOrder.clubBulkPulls.map((pull) => pull.clubName));
    expect(reversed.projectedTotalCallCost).toBe(inOrder.projectedTotalCallCost);
  });
});
