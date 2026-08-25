import { gameweeksRepository, leagueStandingsRepository, leaguesRepository } from "../db/repositories";
import { calculateTeamScores } from "./calculateTeamScores";
import { updateStandings } from "./updateStandings";

/**
 * Rebuilds one gameweek's TeamScore rows and every league's LeagueStanding row for that gameweek,
 * given only the gameweek's id — plus refreshes every later gameweek's standings table in each
 * league, since totalPoints is cumulative through its own gameweek and rebuilding an earlier one
 * silently invalidates every later one already on the books.
 *
 * calculateTeamScores and updateStandings are both delete-then-insert rebuilds, so calling this is
 * always safe to repeat, including for a gameweek whose Gameweek.status is already COMPLETED —
 * this function deliberately never touches gameweeksRepository.markCompleted or
 * awardGameweekFreeTransfers. Those are one-shot completion actions (awardGameweekFreeTransfers
 * unconditionally adds +2 to every team's banked transfers, with nothing to detect a repeat run)
 * that belong solely to processMatchDataChanges's completion cascade — reopening them here would
 * double-award transfers on the second correction a gameweek ever gets.
 *
 * Shared by three callers: processMatchDataChanges (after a match completes or a gameweek closes,
 * gated on isGameweekTableStale), confirmationPasses (after a late provider correction lands —
 * unconditionally, regardless of the gameweek's status), and backfillMissingMatchStatsAndScores
 * (the one-off manual recovery script).
 */
export async function rebuildGameweekScoresAndStandings(gameweekId: string): Promise<void> {
  const gameweek = await gameweeksRepository.findById(gameweekId);
  if (!gameweek) return; // defensive only — gameweekId always comes off a Match's gameweek_id FK

  await calculateTeamScores(gameweekId);

  const leagues = await leaguesRepository.findAll();
  for (const league of leagues) {
    await updateStandings(league.id, gameweekId);

    const laterGameweekIds = await leagueStandingsRepository.findGameweekIdsWithStandingsAfter(
      league.id,
      gameweek.number,
    );
    for (const laterGameweekId of laterGameweekIds) {
      await updateStandings(league.id, laterGameweekId);
    }
  }
}
