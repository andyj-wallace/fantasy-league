import { gameweeksRepository, matchesRepository } from "../db/repositories";
import { awardGameweekFreeTransfers } from "./awardGameweekFreeTransfers";
import { awardPostponedMatchTransfers } from "./awardPostponedMatchTransfers";
import { calculatePlayerScores } from "./calculatePlayerScores";
import type { ImportMatchDataResult } from "./importMatchData";
import { rebuildGameweekScoresAndStandings } from "./rebuildGameweekScoresAndStandings";

/**
 * The downstream half of a worker cycle: awards postponed-match transfers for any match that
 * just became disrupted (POSTPONED or VOIDED); scores any match that just completed; and rebuilds
 * that gameweek's team scores and every league's standings. Any gameweek touched by either kind of
 * change is then re-checked, and once every one of its matches has reached a final state
 * (COMPLETED or VOIDED) it is additionally marked COMPLETED and every team is awarded its 2 free
 * transfers for the next one. Shared by both the discovery and live-polling import paths so this
 * logic isn't duplicated per call site.
 *
 * Disruptions feed that re-check as well as completions because VOIDED is a final state: when the
 * round's last unresolved fixture is abandoned or awarded rather than played, the gameweek is
 * finished and no later completion will ever arrive to say so. Deriving the re-check set from
 * completions alone left such a gameweek open forever — its managers never receiving their free
 * transfers, its final standings never written.
 *
 * The score/standings rebuild deliberately runs after *every* completed match rather than only at
 * gameweek end, so the leaderboard moves through a matchday instead of sitting empty until the last
 * fixture is final. The rebuild itself is delegated to rebuildGameweekScoresAndStandings, an
 * idempotent delete-then-insert operation shared with confirmationPasses (late corrections landing
 * after gameweek close) and backfillMissingMatchStatsAndScores (manual recovery) — see the note
 * below for the one step here that isn't idempotent.
 */
export async function processMatchDataChanges(result: ImportMatchDataResult): Promise<void> {
  const { newlyCompletedMatchIds, newlyDisruptedMatchIds } = result;

  // Two sets because the two kinds of change earn different follow-up. Either kind can be the one
  // that puts a gameweek's last outstanding fixture into a final state, so both feed the
  // completion re-check; only a completion produces new PlayerScore rows, so only a completion
  // makes an otherwise-unfinished gameweek's team scores and standings stale.
  const gameweekIdsNeedingCompletionRecheck = new Set<string>();
  const gameweekIdsWithNewlyScoredMatches = new Set<string>();

  for (const matchId of newlyDisruptedMatchIds) {
    await awardPostponedMatchTransfers(matchId);

    // POSTPONED and VOIDED are not distinguished here on purpose. A POSTPONED match is still
    // pending as far as areAllMatchesCompleted is concerned, so adding its gameweek cannot
    // complete anything — it buys one harmless re-check that returns false — while a VOIDED one
    // genuinely can be the fixture that finishes the round.
    const match = await matchesRepository.findById(matchId);
    if (match) gameweekIdsNeedingCompletionRecheck.add(match.gameweekId);
  }

  for (const matchId of newlyCompletedMatchIds) {
    await calculatePlayerScores(matchId);
    const match = await matchesRepository.findById(matchId);
    if (!match) continue;
    gameweekIdsNeedingCompletionRecheck.add(match.gameweekId);
    gameweekIdsWithNewlyScoredMatches.add(match.gameweekId);
  }

  for (const gameweekId of gameweekIdsNeedingCompletionRecheck) {
    // Never re-run the one-shot completion actions below (markCompleted, awardGameweekFreeTransfers)
    // for a finalized gameweek — awardGameweekFreeTransfers is not idempotent, so a second run would
    // gift every manager two extra transfers. The score/standings rebuild further down has no such
    // restriction (see rebuildGameweekScoresAndStandings) and is safe to re-run for a COMPLETED
    // gameweek — that path is confirmationPasses's job, not this one. The null case cannot happen —
    // gameweekId came off a Match row, whose gameweek_id is a foreign key.
    const gameweek = await gameweeksRepository.findById(gameweekId);
    if (!gameweek || gameweek.status === "COMPLETED") continue;

    const hasEveryMatchReachedAFinalState = await gameweeksRepository.areAllMatchesCompleted(gameweekId);

    // The completion cascade must fire exactly once per gameweek: awardGameweekFreeTransfers is
    // not idempotent — it increments every team's banked transfers by 2 unconditionally — so a
    // second run silently gifts every manager two extra transfers. The only guard downstream of
    // here is importMatchData reporting a match as newly completed or newly disrupted solely on a
    // genuine transition, and live-poll reconciliation now opens a second route into those lists
    // (docs/stuck-live-match-reconciliation-plan.md), so it stays gated on the gameweek actually
    // being finished, and on the already-COMPLETED check above.
    if (hasEveryMatchReachedAFinalState) {
      await gameweeksRepository.markCompleted(gameweekId);
      await awardGameweekFreeTransfers();
    }

    // Idempotent rebuilds, so these run on every pass that has something to say — a provisional
    // table after each completed match, and the same code path producing the final one once the
    // gameweek closes. A gameweek closed by a VOID gets one too even though the void itself scored
    // nothing: the standings it needs are its *final* ones, and the free-transfer award just above
    // moves bankedFreeTransferCount, which is one of the standings tiebreakers.
    //
    // A gameweek that is neither finished nor newly scored — a lone postponement, which can land
    // on a round weeks away — is deliberately left alone, so a future gameweek doesn't get a
    // premature standings row written against it.
    const isGameweekTableStale =
      hasEveryMatchReachedAFinalState || gameweekIdsWithNewlyScoredMatches.has(gameweekId);
    if (!isGameweekTableStale) continue;

    await rebuildGameweekScoresAndStandings(gameweekId);
  }
}
