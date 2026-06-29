import { pendingConfirmationPassesRepository, playerMatchStatsRepository } from "../db/repositories";
import { calculatePlayerScores } from "./calculatePlayerScores";
import type { FootballDataProvider } from "./footballDataProvider";
import { resolvePlayerMatchStats } from "./importMatchData";

/**
 * Re-polls any Match whose confirmation pass has come due (~45-60min after MATCH_COMPLETED,
 * per the Live-Match Polling Strategy in Fantasy League Architecture.txt), replacing its
 * PlayerMatchStat rows with the provider's latest (catching late VAR corrections) and
 * recalculating that match's PlayerScore rows.
 *
 * Deliberately does not cascade into recalculateTeamScores/updateStandings for a gameweek that's
 * already been marked COMPLETED — re-opening finalized standings on a late correction is a
 * separate design question, tracked as a follow-up in docs/remaining-gaps-todo.md.
 */
export async function runDueConfirmationPasses(provider: FootballDataProvider): Promise<void> {
  const duePasses = await pendingConfirmationPassesRepository.findDue(new Date());

  for (const pass of duePasses) {
    const providerStats = await provider.fetchFixturePlayerStats(pass.externalFixtureId);
    const stats = await resolvePlayerMatchStats(pass.matchId, providerStats);
    await playerMatchStatsRepository.replaceForMatch(pass.matchId, stats);
    await calculatePlayerScores(pass.matchId);
    await pendingConfirmationPassesRepository.remove(pass.id);
  }
}
