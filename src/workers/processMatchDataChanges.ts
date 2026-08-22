import { gameweeksRepository, leaguesRepository, matchesRepository } from "../db/repositories";
import { awardGameweekFreeTransfers } from "./awardGameweekFreeTransfers";
import { awardPostponedMatchTransfers } from "./awardPostponedMatchTransfers";
import { calculatePlayerScores } from "./calculatePlayerScores";
import { calculateTeamScores } from "./calculateTeamScores";
import type { ImportMatchDataResult } from "./importMatchData";
import { updateStandings } from "./updateStandings";

/**
 * The downstream half of a worker cycle: awards postponed-match transfers for any match that
 * just became disrupted (POSTPONED or VOIDED); scores any match that just completed; and — once
 * every match in a gameweek has reached a final state (COMPLETED or VOIDED) — marks that gameweek
 * COMPLETED, awards every team its 2 free transfers for the next one, and recalculates that
 * gameweek's team scores and every league's standings. Shared by both the discovery and
 * live-polling import paths so this logic isn't duplicated per call site.
 */
export async function processMatchDataChanges(result: ImportMatchDataResult): Promise<void> {
  const { newlyCompletedMatchIds, newlyDisruptedMatchIds } = result;

  for (const matchId of newlyDisruptedMatchIds) {
    await awardPostponedMatchTransfers(matchId);
  }

  const affectedGameweekIds = new Set<string>();
  for (const matchId of newlyCompletedMatchIds) {
    await calculatePlayerScores(matchId);
    const match = await matchesRepository.findById(matchId);
    if (match) affectedGameweekIds.add(match.gameweekId);
  }

  for (const gameweekId of affectedGameweekIds) {
    // The completion cascade must fire exactly once per gameweek: awardGameweekFreeTransfers is
    // not idempotent — it increments every team's banked transfers by 2 unconditionally — so a
    // second run silently gifts every manager two extra transfers. The only guard downstream of
    // here is importMatchData reporting a match as newly completed solely on a genuine transition,
    // and live-poll reconciliation now opens a second route into that list
    // (docs/stuck-live-match-reconciliation-plan.md), so an already-COMPLETED gameweek is checked
    // explicitly. Same reasoning as the confirmation pass's "never re-open a finalized gameweek".
    const gameweek = await gameweeksRepository.findById(gameweekId);
    if (gameweek?.status === "COMPLETED") continue;

    const isGameweekFullyScored = await gameweeksRepository.areAllMatchesCompleted(gameweekId);
    if (!isGameweekFullyScored) continue;

    await gameweeksRepository.markCompleted(gameweekId);
    await awardGameweekFreeTransfers();
    await calculateTeamScores(gameweekId);

    const leagues = await leaguesRepository.findAll();
    for (const league of leagues) {
      await updateStandings(league.id, gameweekId);
    }
  }
}
