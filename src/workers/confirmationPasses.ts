import { pendingConfirmationPassesRepository, playerMatchStatsRepository } from "../db/repositories";
import { calculatePlayerScores } from "./calculatePlayerScores";
import type { FootballDataProvider } from "./footballDataProvider";
import { resolvePlayerMatchStats } from "./importMatchData";

/**
 * Re-polls any Match whose confirmation pass has come due (~45-60min after MATCH_COMPLETED,
 * per the Live-Match Polling Strategy in Fantasy League Architecture.txt), replacing its
 * PlayerMatchStat rows with the provider's latest (catching late provider stat corrections) and
 * recalculating that match's PlayerScore rows.
 *
 * Decided 2026-07-02: this pass never cascades into calculateTeamScores/updateStandings for a
 * gameweek already marked COMPLETED. VAR corrections resolve during the match itself, so a
 * correction landing after the whole gameweek is finalized is not a real scenario worth
 * re-opening standings for. The pass remains a safety net for corrections that land while the
 * gameweek is still open — those flow into calculateTeamScores/updateStandings naturally when
 * processMatchDataChanges later marks the gameweek COMPLETED.
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
