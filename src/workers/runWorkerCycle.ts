import { gameweeksRepository, leaguesRepository, matchesRepository } from "../db/repositories";
import { awardGameweekFreeTransfers } from "./awardGameweekFreeTransfers";
import { awardPostponedMatchTransfers } from "./awardPostponedMatchTransfers";
import { calculatePlayerScores } from "./calculatePlayerScores";
import { calculateTeamScores } from "./calculateTeamScores";
import { StubFootballDataProvider, type FootballDataProvider } from "./footballDataProvider";
import { importMatchData } from "./importMatchData";
import { updateStandings } from "./updateStandings";

/**
 * The full poll-and-process pass: one call per scheduled trigger (every 1-5 minutes in prod).
 * Imports match updates; awards postponed-match transfers for any match that just became
 * POSTPONED; scores any match that just completed; and — once every match in a gameweek has
 * reached a final state — marks that gameweek COMPLETED, awards every team its 2 free transfers
 * for the next one, and recalculates that gameweek's team scores and every league's standings.
 */
export async function runWorkerCycle(
  provider: FootballDataProvider = new StubFootballDataProvider(),
): Promise<void> {
  const { newlyCompletedMatchIds, newlyPostponedMatchIds } = await importMatchData(provider);

  for (const matchId of newlyPostponedMatchIds) {
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
