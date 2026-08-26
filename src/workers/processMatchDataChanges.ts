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
 * change is then re-checked, and once nothing is still holding it open it is additionally closed
 * and every team awarded its 2 free transfers for the next one. Shared by both the discovery and
 * live-polling import paths so this logic isn't duplicated per call site.
 *
 * Disruptions feed that re-check as well as completions because neither VOIDED nor POSTPONED
 * blocks a round from closing: when the round's last outstanding fixture is abandoned, awarded or
 * put off to a later date rather than played, the round is finished and no later completion will
 * ever arrive to say so. Deriving the re-check set from completions alone left such a gameweek open
 * forever — its managers never receiving their free transfers, its final standings never written.
 *
 * Two rounds closing in one batch is a correct outcome, not something to suppress. A Gameweek 10
 * fixture replayed on the Gameweek 12 weekend closes Gameweek 10 (long overdue) alongside Gameweek
 * 12, and fantasy_league_v1_design.txt grants 2 free transfers *per gameweek*, so every manager
 * banking 2 + 2 is two rounds' correct settlement — one of them merely paid late. What must never
 * happen is one round paying twice, and that is guarded by markCompletedIfNotAlready rather than by
 * any per-batch cap.
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

    // POSTPONED and VOIDED are not distinguished here on purpose: either can be the fixture whose
    // resolution finishes the round. A postponement landing on a round weeks away still finds that
    // round's other fixtures SCHEDULED and so completes nothing — one harmless re-check — while a
    // postponement of a round's last outstanding fixture closes it, which is the point.
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
    const hasEveryMatchStoppedBlockingCompletion =
      await gameweeksRepository.hasEveryMatchStoppedBlockingGameweekCompletion(gameweekId);

    // The one-shot half of the cascade, and the only part of this function that is not safe to
    // repeat: awardGameweekFreeTransfers adds +2 to every team in the game and keeps no ledger of
    // having done so. What makes it once-per-round is markCompletedIfNotAlready — a single
    // conditional UPDATE that flips the status and reports whether this call was the one that
    // flipped it — so the award is bound to a state transition rather than to a read of the status
    // taken moments earlier. That matters because importMatchData is no longer the only route into
    // these lists (live-poll reconciliation opened a second one, see
    // docs/stuck-live-match-reconciliation-plan.md) and because a round can now close while a
    // postponed fixture is still to be played, which means a *later* completion for an
    // already-closed round is expected traffic rather than a bug.
    if (hasEveryMatchStoppedBlockingCompletion) {
      const didThisCallCloseTheGameweek = await gameweeksRepository.markCompletedIfNotAlready(gameweekId);
      if (didThisCallCloseTheGameweek) await awardGameweekFreeTransfers(gameweekId);
    }

    // Idempotent rebuilds, so these run on every pass that has something to say — a provisional
    // table after each completed match, and the same code path producing the final one once the
    // gameweek closes. Deliberately *not* gated on the gameweek being open: when the postponed
    // fixture of an already-closed round is finally replayed, correcting that round's scores and
    // cascading the correction into every later round is exactly what it needs, and the old
    // `if (status === "COMPLETED") continue` above skipped this rebuild along with the award,
    // leaving it to the confirmation pass ~50 minutes later. A gameweek closed by a VOID gets a
    // rebuild too even though the void itself scored nothing: the standings it needs are its
    // *final* ones, and the free-transfer award just above moves bankedFreeTransferCount, which is
    // one of the standings tiebreakers.
    //
    // A gameweek that is neither finished nor newly scored — a lone postponement landing on a round
    // weeks away — is still left alone, so a future gameweek doesn't get a premature standings row
    // written against it.
    const isGameweekTableStale =
      hasEveryMatchStoppedBlockingCompletion || gameweekIdsWithNewlyScoredMatches.has(gameweekId);
    if (!isGameweekTableStale) continue;

    await rebuildGameweekScoresAndStandings(gameweekId);
  }
}
