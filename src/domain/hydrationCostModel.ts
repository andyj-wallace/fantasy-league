import { PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID } from "./constants";

/**
 * Chooses, for a cohort of players still waiting on a previous-season stat line, the cheapest
 * mix of provider pulls that covers them — and says what that mix will cost before any of it is
 * spent. Pure: no provider, no database, no clock, so the interesting reasoning is unit-testable
 * the way leagueStrength.ts and gameStateGoalBonus.ts are.
 *
 * Three ways exist to reach the same stat line, and they differ by an order of magnitude:
 *
 * - **Individual lookup** — one unscoped `/players?id&season` call per player. Always available,
 *   always works, costs one call per head.
 * - **Per-club bulk pull** — one club's whole previous season in ~2 pages. It resolves every
 *   player who was *already at that club* last season, which is exactly the promoted-club case:
 *   a 25-man squad for 2 calls instead of 25.
 * - **Per-league bulk pull** — a whole league's previous season, ~28 pages for the Premier
 *   League. Only worth it when a large share of the cohort shares one source league, which is
 *   the ordinary pre-season shape: most of the current roster played in the Premier League last
 *   season, and 28 pages beats seventeen separate club pulls at 34.
 *
 * The chooser is a plain greedy search — take the league bulk that saves the most against the
 * best club-bulk/individual plan for the same players, commit it, and look again. Cohorts here
 * are a few hundred players across at most a few dozen sources, so nothing subtler is warranted.
 */

/** One player still sitting at his position's placeholder price, waiting to be priced. */
export interface UnpricedPlayerHydrationCandidate {
  playerExternalId: string;
  /** The club he plays for *now* — what a per-club bulk pull is keyed on. */
  currentClubName: string;
  /** The league his previous season is expected to be found in, when something already suggests
   * one: his club having been in the reference league last season, or an earlier run's persisted
   * source-league tally. null when nothing does, which keeps him out of every league-bulk pull —
   * a league bulk must never be justified by players it might not contain. */
  expectedPreviousSeasonLeagueId: number | null;
}

/** Measured call costs for each pull, so the chooser is calibrated by observation rather than by
 * assumption. See docs/new-player-pricing.md for where these numbers came from. */
export interface HydrationCallCostEstimates {
  /** Pages one club's previous season costs (`/players?team&season`). */
  perClubBulkPullCallCost: number;
  /** Pages a whole league's previous season costs. A league absent from this record has no
   * league-bulk path at all and will never be proposed — which is how the model is told that the
   * provider's league-wide pull only speaks Premier League. */
  perLeagueBulkPullCallCostByLeagueId: Readonly<Record<number, number>>;
  /** One unscoped per-player lookup. */
  perIndividualLookupCallCost: number;
}

/** Bulk pulls a previous run already paid for. Re-running one re-learns what the checkpoint
 * already knows, so these are struck out of the plan rather than re-proposed. */
export interface PreviouslySpentBulkPulls {
  clubNames: ReadonlySet<string>;
  leagueIds: ReadonlySet<number>;
}

export interface PlannedLeagueBulkPull {
  leagueId: number;
  playerExternalIds: string[];
  callCost: number;
}

export interface PlannedClubBulkPull {
  clubName: string;
  playerExternalIds: string[];
  callCost: number;
}

export interface UnpricedPlayerHydrationPlan {
  leagueBulkPulls: PlannedLeagueBulkPull[];
  clubBulkPulls: PlannedClubBulkPull[];
  individualLookupPlayerExternalIds: string[];
  projectedTotalCallCost: number;
}

/** Measured against the real API-Football Pro tier on 2026-08-20 — a club is ~2 pages, the
 * Premier League ~28, the Championship ~48. Only the Premier League carries a league-bulk cost
 * because `fetchAllPlayerSeasonStatistics` is the only league-wide pull the provider exposes and
 * it is scoped to the Premier League. */
export const MEASURED_HYDRATION_CALL_COST_ESTIMATES: HydrationCallCostEstimates = {
  perClubBulkPullCallCost: 2,
  perLeagueBulkPullCallCostByLeagueId: { [PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID]: 28 },
  perIndividualLookupCallCost: 1,
};

const NOTHING_SPENT_YET: PreviouslySpentBulkPulls = { clubNames: new Set(), leagueIds: new Set() };

/** The best plan reachable without any league-wide pull: bulk the clubs that are cheaper in bulk,
 * look the rest up one at a time. */
function planWithoutLeagueBulkPulls(
  candidates: readonly UnpricedPlayerHydrationCandidate[],
  estimates: HydrationCallCostEstimates,
  alreadySpent: PreviouslySpentBulkPulls,
): Pick<UnpricedPlayerHydrationPlan, "clubBulkPulls" | "individualLookupPlayerExternalIds" | "projectedTotalCallCost"> {
  const candidatesByClubName = new Map<string, UnpricedPlayerHydrationCandidate[]>();
  for (const candidate of candidates) {
    const forClub = candidatesByClubName.get(candidate.currentClubName) ?? [];
    forClub.push(candidate);
    candidatesByClubName.set(candidate.currentClubName, forClub);
  }

  const clubBulkPulls: PlannedClubBulkPull[] = [];
  const individualLookupPlayerExternalIds: string[] = [];

  // Sorted so the same cohort always yields the same plan — an operator comparing two previews
  // should be reading a real difference, not a map-iteration difference.
  for (const clubName of [...candidatesByClubName.keys()].sort()) {
    const forClub = candidatesByClubName.get(clubName)!;
    const individualCost = forClub.length * estimates.perIndividualLookupCallCost;
    const isWorthBulking = !alreadySpent.clubNames.has(clubName) && estimates.perClubBulkPullCallCost < individualCost;
    if (isWorthBulking) {
      clubBulkPulls.push({
        clubName,
        playerExternalIds: forClub.map((candidate) => candidate.playerExternalId),
        callCost: estimates.perClubBulkPullCallCost,
      });
    } else {
      individualLookupPlayerExternalIds.push(...forClub.map((candidate) => candidate.playerExternalId));
    }
  }

  const projectedTotalCallCost =
    clubBulkPulls.reduce((total, pull) => total + pull.callCost, 0) +
    individualLookupPlayerExternalIds.length * estimates.perIndividualLookupCallCost;

  return { clubBulkPulls, individualLookupPlayerExternalIds, projectedTotalCallCost };
}

/**
 * Picks the pulls to run and projects what they will cost. Nothing here talks to the provider —
 * the caller prints this, and only then decides whether to spend it.
 *
 * Players a per-club or per-league bulk pull covers may still turn out not to be in it (an
 * incoming transfer was at a different club last season), so the plan is a projection of *calls*,
 * not a promise of coverage; the executor falls back to an individual lookup for whoever a bulk
 * pull missed.
 */
export function planUnpricedPlayerHydration(
  candidates: readonly UnpricedPlayerHydrationCandidate[],
  estimates: HydrationCallCostEstimates = MEASURED_HYDRATION_CALL_COST_ESTIMATES,
  alreadySpent: PreviouslySpentBulkPulls = NOTHING_SPENT_YET,
): UnpricedPlayerHydrationPlan {
  let remainingCandidates = [...candidates];
  const leagueBulkPulls: PlannedLeagueBulkPull[] = [];

  // Greedy: repeatedly commit whichever league-wide pull most reduces the total, until none does.
  for (;;) {
    const costWithoutAnotherLeagueBulk = planWithoutLeagueBulkPulls(remainingCandidates, estimates, alreadySpent)
      .projectedTotalCallCost;

    let bestLeagueBulkPull: PlannedLeagueBulkPull | null = null;
    let bestTotalCallCost = costWithoutAnotherLeagueBulk;

    const eligibleLeagueIds = [...new Set(remainingCandidates.map((c) => c.expectedPreviousSeasonLeagueId))]
      .filter((leagueId): leagueId is number => leagueId !== null && !alreadySpent.leagueIds.has(leagueId))
      .filter((leagueId) => estimates.perLeagueBulkPullCallCostByLeagueId[leagueId] !== undefined)
      .sort((a, b) => a - b);

    for (const leagueId of eligibleLeagueIds) {
      const covered = remainingCandidates.filter((c) => c.expectedPreviousSeasonLeagueId === leagueId);
      const uncovered = remainingCandidates.filter((c) => c.expectedPreviousSeasonLeagueId !== leagueId);
      const callCost = estimates.perLeagueBulkPullCallCostByLeagueId[leagueId]!;
      const totalCallCost =
        callCost + planWithoutLeagueBulkPulls(uncovered, estimates, alreadySpent).projectedTotalCallCost;
      if (totalCallCost < bestTotalCallCost) {
        bestTotalCallCost = totalCallCost;
        bestLeagueBulkPull = {
          leagueId,
          playerExternalIds: covered.map((c) => c.playerExternalId),
          callCost,
        };
      }
    }

    if (!bestLeagueBulkPull) break;
    leagueBulkPulls.push(bestLeagueBulkPull);
    const committedLeagueId = bestLeagueBulkPull.leagueId;
    remainingCandidates = remainingCandidates.filter((c) => c.expectedPreviousSeasonLeagueId !== committedLeagueId);
  }

  const rest = planWithoutLeagueBulkPulls(remainingCandidates, estimates, alreadySpent);
  return {
    leagueBulkPulls,
    clubBulkPulls: rest.clubBulkPulls,
    individualLookupPlayerExternalIds: rest.individualLookupPlayerExternalIds,
    projectedTotalCallCost:
      leagueBulkPulls.reduce((total, pull) => total + pull.callCost, 0) + rest.projectedTotalCallCost,
  };
}
