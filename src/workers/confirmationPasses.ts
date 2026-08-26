import type { PendingConfirmationPass } from "../db/repositories/pendingConfirmationPasses";
import { matchGoalEventsRepository, matchesRepository, pendingConfirmationPassesRepository, playerMatchStatsRepository } from "../db/repositories";
import { calculatePlayerScores } from "./calculatePlayerScores";
import type { FootballDataProvider } from "./footballDataProvider";
import { resolveMatchGoalEvents, resolvePlayerMatchStats } from "./importMatchData";
import { rebuildGameweekScoresAndStandings } from "./rebuildGameweekScoresAndStandings";

/**
 * How many times a due confirmation pass may be attempted before it is abandoned rather than
 * retried again. Five attempts on the backoff schedule below spans roughly an hour of retrying —
 * long enough to ride out a provider outage, short enough that a permanently broken pass is gone
 * before the next matchday's passes are scheduled.
 *
 * It lives here, beside the backoff it composes with, rather than in src/domain: the cap and the
 * schedule are one retry policy and reading them apart tells you less than reading them together.
 * Exported so tests can drive a pass to exactly its last permitted attempt.
 */
export const MAX_CONFIRMATION_PASS_ATTEMPTS = 5;
/** First retry delay after a failed attempt; doubles per attempt up to the cap below. Five
 * minutes is the provider's own live-update granularity — retrying faster cannot learn anything
 * new. On the schedule this produces (5, 10, 20, 30 min) a pass gets ~65 minutes to come good. */
const CONFIRMATION_PASS_RETRY_BASE_DELAY_MS = 5 * 60 * 1000;
/** Ceiling on the backoff. A confirmation pass is only useful while the correction it is chasing
 * is still fresh, so there is no point waiting hours between attempts. */
const CONFIRMATION_PASS_RETRY_MAX_DELAY_MS = 30 * 60 * 1000;
/** A provider error message goes into a `text` column verbatim; a runaway one (a whole HTML error
 * page, say) is truncated so one bad response cannot bloat the row. */
const MAX_STORED_CONFIRMATION_PASS_ERROR_LENGTH = 1000;

/**
 * Why an attempt did not produce a correction. A confirmation pass has exactly two failure modes
 * and they are handled identically — bounded retries, then abandonment — because both mean the
 * same thing: the provider did not give us a usable answer this time.
 */
const PROVIDER_RETURNED_NO_STATS_FOR_COMPLETED_MATCH =
  "provider returned an empty player-stat set for a COMPLETED match (fixture-stats coverage is probably off)";

/** The result of one attempt: either the correction landed (and the pass is gone), or it did not
 * and the caller has to decide between deferring the pass and abandoning it. */
type ConfirmationPassAttemptOutcome =
  | { correctionApplied: true; gameweekIdToRebuild: string | null }
  | { correctionApplied: false; failureReason: string };

function describeConfirmationPassFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_STORED_CONFIRMATION_PASS_ERROR_LENGTH);
}

function retryDelayAfterFailedAttemptMs(attemptCount: number): number {
  const exponentialDelayMs = CONFIRMATION_PASS_RETRY_BASE_DELAY_MS * 2 ** (attemptCount - 1);
  return Math.min(exponentialDelayMs, CONFIRMATION_PASS_RETRY_MAX_DELAY_MS);
}

/**
 * One pass's re-poll and correction, contained.
 *
 * Modelled on fetchReconciliationFixturesOrDegrade in liveMatchPolling.ts — the same
 * degrade-and-warn shape, for the same reason. Six awaits run ahead of the pass's removal, and
 * before 2026-08-26 none of them was guarded: a throw from any one left the row in place with its
 * already-past dueAt untouched, so it came due again on the very next cycle and re-failed forever,
 * blocking every later pass in the same batch on the way (findDue orders by due_at but the batch
 * is still processed in one loop).
 */
async function attemptConfirmationPass(
  provider: FootballDataProvider,
  pass: PendingConfirmationPass,
): Promise<ConfirmationPassAttemptOutcome> {
  try {
    // Read the match before the provider call: its status decides whether an empty answer is a
    // legitimate correction or the coverage-off trap below.
    const match = await matchesRepository.findById(pass.matchId);
    const { playerStats, goalEvents: providerGoalEvents } = await provider.fetchFixturePlayerStatsAndGoalEvents(
      pass.externalFixtureId,
    );

    // ApiFootballProvider.fetchFixturePlayerStatsAndGoalEvents returns an empty set rather than
    // throwing when statistics_players coverage is off for the season. Handing that to
    // replaceForMatch would delete every player's stat line for a match that certainly had one and
    // recalculate the whole match to zero — a worse outcome than any stuck pass. A finished match
    // with no stats is never a correction, so treat it as an attempt that failed.
    if (playerStats.length === 0 && match?.status === "COMPLETED") {
      return { correctionApplied: false, failureReason: PROVIDER_RETURNED_NO_STATS_FOR_COMPLETED_MATCH };
    }

    const stats = await resolvePlayerMatchStats(pass.matchId, playerStats);
    await playerMatchStatsRepository.replaceForMatch(pass.matchId, stats);
    await matchGoalEventsRepository.replaceForMatch(pass.matchId, await resolveMatchGoalEvents(pass.matchId, providerGoalEvents));
    await calculatePlayerScores(pass.matchId);
    await pendingConfirmationPassesRepository.remove(pass.id);

    return { correctionApplied: true, gameweekIdToRebuild: match ? match.gameweekId : null };
  } catch (error) {
    return { correctionApplied: false, failureReason: describeConfirmationPassFailure(error) };
  }
}

/**
 * Books a failed attempt: defer the pass onto its backoff, or abandon it once it has used up
 * MAX_CONFIRMATION_PASS_ATTEMPTS.
 *
 * Abandoning is deliberately the end of the line rather than an indefinite retry. The match keeps
 * the stats importMatchData wrote when it first completed, so a confirmation pass is a *correction*
 * opportunity, not the source of truth for the match: giving up on one degrades the accuracy of
 * that match's scores by whatever the provider later revised, and loses nothing else. Retrying
 * forever, by contrast, costs 2 provider calls every cycle in perpetuity, permanently reserves
 * budget against the live-poll cadence, and — before the containment above — took the whole worker
 * cycle down with it. Hence the loud console.error: the pass is gone, and the only record that it
 * ever existed is that line plus the row's lastError before deletion.
 */
async function deferOrAbandonFailedConfirmationPass(pass: PendingConfirmationPass, failureReason: string): Promise<void> {
  const attemptCount = pass.attemptCount + 1;
  const attemptedAt = new Date();

  if (attemptCount >= MAX_CONFIRMATION_PASS_ATTEMPTS) {
    console.error(
      `[confirmationPasses] abandoning confirmation pass after ${attemptCount} failed attempts — match ` +
        `${pass.matchId}, fixture ${pass.externalFixtureId}. The match keeps its originally-imported stats; ` +
        `any provider correction to it is now permanently unapplied. Last error: ${failureReason}`,
    );
    await pendingConfirmationPassesRepository.remove(pass.id);
    return;
  }

  const retryDelayMs = retryDelayAfterFailedAttemptMs(attemptCount);
  await pendingConfirmationPassesRepository.recordFailedAttempt(pass.id, {
    attemptCount,
    lastAttemptedAt: attemptedAt,
    lastError: failureReason,
    nextDueAt: new Date(attemptedAt.getTime() + retryDelayMs),
  });
  console.warn(
    `[confirmationPasses] attempt ${attemptCount}/${MAX_CONFIRMATION_PASS_ATTEMPTS} failed for match ` +
      `${pass.matchId} (fixture ${pass.externalFixtureId}) — retrying in ${Math.round(retryDelayMs / 60000)} min: ` +
      failureReason,
  );
}

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
 * insert rebuilds and deliberately never touches gameweeksRepository.markCompletedIfNotAlready or
 * awardGameweekFreeTransfers — those one-shot completion actions already fired the first time the
 * gameweek closed and live only in processMatchDataChanges's completion cascade, where the award is
 * bound to markCompletedIfNotAlready's conditional UPDATE actually flipping the status. Re-running
 * the rebuild a second (or fifth) time for the same gameweek changes nothing but the numbers.
 *
 * Multiple due passes can share a gameweek in one cycle, so affected gameweek ids are collected
 * into a set and each is rebuilt once, after every pass's PlayerScore correction has been applied
 * — not once per match.
 *
 * Every pass is attempted independently (2026-08-26): a failing one is deferred or abandoned and
 * the loop moves on, so no single bad pass can cost the batch the corrections it was going to
 * make. See attemptConfirmationPass and deferOrAbandonFailedConfirmationPass.
 */
export async function runDueConfirmationPasses(provider: FootballDataProvider): Promise<void> {
  const duePasses = await pendingConfirmationPassesRepository.findDue(new Date());
  const gameweekIdsToRebuild = new Set<string>();

  for (const pass of duePasses) {
    const outcome = await attemptConfirmationPass(provider, pass);

    if (!outcome.correctionApplied) {
      await deferOrAbandonFailedConfirmationPass(pass, outcome.failureReason);
      continue;
    }

    if (outcome.gameweekIdToRebuild) gameweekIdsToRebuild.add(outcome.gameweekIdToRebuild);
  }

  for (const gameweekId of gameweekIdsToRebuild) {
    await rebuildGameweekScoresAndStandings(gameweekId);
  }
}
