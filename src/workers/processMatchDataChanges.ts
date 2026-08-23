import { gameweeksRepository, leaguesRepository, matchesRepository } from "../db/repositories";
import { awardGameweekFreeTransfers } from "./awardGameweekFreeTransfers";
import { awardPostponedMatchTransfers } from "./awardPostponedMatchTransfers";
import { calculatePlayerScores } from "./calculatePlayerScores";
import { calculateTeamScores } from "./calculateTeamScores";
import type { ImportMatchDataResult } from "./importMatchData";
import { updateStandings } from "./updateStandings";

/**
 * The downstream half of a worker cycle: awards postponed-match transfers for any match that
 * just became disrupted (POSTPONED or VOIDED); scores any match that just completed; and rebuilds
 * that gameweek's team scores and every league's standings. Once every match in the gameweek has
 * reached a final state (COMPLETED or VOIDED) it additionally marks the gameweek COMPLETED and
 * awards every team its 2 free transfers for the next one. Shared by both the discovery and
 * live-polling import paths so this logic isn't duplicated per call site.
 *
 * The score/standings rebuild deliberately runs after *every* completed match rather than only at
 * gameweek end, so the leaderboard moves through a matchday instead of sitting empty until the last
 * fixture is final. Both calculateTeamScores and updateStandings are delete-then-insert rebuilds of
 * the whole gameweek, so re-running them mid-gameweek is idempotent — see the note below for the
 * one step that isn't.
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
    // Never re-open a finalized gameweek: its scores and standings are already final, and the
    // completion cascade below must not run twice. Same reasoning as the confirmation pass.
    const gameweek = await gameweeksRepository.findById(gameweekId);
    if (gameweek?.status === "COMPLETED") continue;

    const isGameweekFullyScored = await gameweeksRepository.areAllMatchesCompleted(gameweekId);

    // The completion cascade must fire exactly once per gameweek: awardGameweekFreeTransfers is
    // not idempotent — it increments every team's banked transfers by 2 unconditionally — so a
    // second run silently gifts every manager two extra transfers. The only guard downstream of
    // here is importMatchData reporting a match as newly completed solely on a genuine transition,
    // and live-poll reconciliation now opens a second route into that list
    // (docs/stuck-live-match-reconciliation-plan.md), so it stays gated on the gameweek actually
    // being finished, and on the already-COMPLETED check above.
    if (isGameweekFullyScored) {
      await gameweeksRepository.markCompleted(gameweekId);
      await awardGameweekFreeTransfers();
    }

    // Idempotent rebuilds, so these run on every pass — a provisional table after each match, and
    // the same code path producing the final one once the gameweek closes.
    await calculateTeamScores(gameweekId);

    const leagues = await leaguesRepository.findAll();
    for (const league of leagues) {
      await updateStandings(league.id, gameweekId);
    }
  }
}
