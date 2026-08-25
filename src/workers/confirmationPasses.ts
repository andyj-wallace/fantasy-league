import { matchGoalEventsRepository, matchesRepository, pendingConfirmationPassesRepository, playerMatchStatsRepository } from "../db/repositories";
import { calculatePlayerScores } from "./calculatePlayerScores";
import type { FootballDataProvider } from "./footballDataProvider";
import { resolveMatchGoalEvents, resolvePlayerMatchStats } from "./importMatchData";
import { rebuildGameweekScoresAndStandings } from "./rebuildGameweekScoresAndStandings";

/**
 * Re-polls any Match whose confirmation pass has come due (~45-60min after MATCH_COMPLETED,
 * per the Live-Match Polling Strategy in Fantasy League Architecture.txt), replacing its
 * PlayerMatchStat rows with the provider's latest (catching late provider stat corrections) and
 * recalculating that match's PlayerScore rows.
 *
 * Revised 2026-08-25, superseding a 2026-07-02 decision that this pass would never cascade into
 * calculateTeamScores/updateStandings for an already-COMPLETED gameweek, on the assumption that a
 * correction landing after gameweek close "is not a real scenario." The 2026-08-24 production
 * incident (commit 811b1c6, "GW 1 points not written bug") proved that assumption wrong: it took a
 * one-off script (backfillMissingMatchStatsAndScores.ts) to manually rebuild TeamScore/
 * LeagueStanding for a gameweek that had already closed, because nothing automated ever would
 * have. This pass now rebuilds unconditionally, regardless of the affected gameweek's status.
 *
 * That's safe because rebuildGameweekScoresAndStandings only performs idempotent delete-then-
 * insert rebuilds and deliberately never touches gameweeksRepository.markCompleted or
 * awardGameweekFreeTransfers — those one-shot completion actions already fired the first time the
 * gameweek closed and live only in processMatchDataChanges's completion cascade. Re-running the
 * rebuild a second (or fifth) time for the same gameweek changes nothing but the numbers.
 *
 * Multiple due passes can share a gameweek in one cycle, so affected gameweek ids are collected
 * into a set and each is rebuilt once, after every pass's PlayerScore correction has been applied
 * — not once per match.
 */
export async function runDueConfirmationPasses(provider: FootballDataProvider): Promise<void> {
  const duePasses = await pendingConfirmationPassesRepository.findDue(new Date());
  const gameweekIdsToRebuild = new Set<string>();

  for (const pass of duePasses) {
    const { playerStats, goalEvents: providerGoalEvents } = await provider.fetchFixturePlayerStatsAndGoalEvents(pass.externalFixtureId);
    const stats = await resolvePlayerMatchStats(pass.matchId, playerStats);
    await playerMatchStatsRepository.replaceForMatch(pass.matchId, stats);
    await matchGoalEventsRepository.replaceForMatch(pass.matchId, await resolveMatchGoalEvents(pass.matchId, providerGoalEvents));
    await calculatePlayerScores(pass.matchId);
    await pendingConfirmationPassesRepository.remove(pass.id);

    const match = await matchesRepository.findById(pass.matchId);
    if (match) gameweekIdsToRebuild.add(match.gameweekId);
  }

  for (const gameweekId of gameweekIdsToRebuild) {
    await rebuildGameweekScoresAndStandings(gameweekId);
  }
}
