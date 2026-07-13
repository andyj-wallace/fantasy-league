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
