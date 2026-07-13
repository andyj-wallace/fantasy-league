import { matchesRepository, pendingConfirmationPassesRepository, providerPollStateRepository } from "../db/repositories";
import type { FootballDataProvider } from "./footballDataProvider";
import { mapApiFootballStatusToMatchStatus } from "./footballMatchStatusMapping";
import { importMatchData, type ImportMatchDataResult } from "./importMatchData";

/** A fixture's live window: 90 min plus stoppage/halftime; no extra time in league play. */
const LIVE_FIXTURE_WINDOW_MINUTES = 110;
/** No point outpacing the provider's own update cycle. */
const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Cadence (and ceiling on "wake for the next kickoff") when nothing is currently live. */
const IDLE_POLL_INTERVAL_CAP_MS = 30 * 60 * 1000;

const NO_OP_RESULT: ImportMatchDataResult = { newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [] };

/**
 * Self-throttling adaptive live-tracking tick from the Live-Match Polling Strategy in
 * Fantasy League Architecture.txt / docs/polling-budget.md. No-ops (cheap DB read only) unless
 * providerPollState.nextLivePollDueAt has passed, so it's safe to call on every worker cycle
 * regardless of how often that cycle runs.
 */
export async function runLiveMatchPollingTick(provider: FootballDataProvider): Promise<ImportMatchDataResult> {
  const pollState = await providerPollStateRepository.getOrCreate();
  const now = new Date();
  if (pollState.nextLivePollDueAt && pollState.nextLivePollDueAt > now) {
    return NO_OP_RESULT;
  }

  const potentiallyLive = await matchesRepository.findPotentiallyLive(now);
  if (potentiallyLive.length === 0) {
    const nextKickoff = await matchesRepository.findEarliestUpcomingKickoff(now);
    const idleDelayMs = nextKickoff
      ? Math.min(nextKickoff.getTime() - now.getTime(), IDLE_POLL_INTERVAL_CAP_MS)
      : IDLE_POLL_INTERVAL_CAP_MS;
    await providerPollStateRepository.update(pollState.id, {
      nextLivePollDueAt: new Date(now.getTime() + Math.max(idleDelayMs, MIN_POLL_INTERVAL_MS)),
    });
    return NO_OP_RESULT;
  }

  const liveFixtures = await provider.fetchLiveFixtures();
  const result = await importMatchData(provider, liveFixtures);

  const stillLiveCount = liveFixtures.filter(
    (fixture) => mapApiFootballStatusToMatchStatus(fixture.statusShortCode) === "IN_PROGRESS",
  ).length;

  let nextDelayMs: number;
  if (stillLiveCount === 0) {
    nextDelayMs = IDLE_POLL_INTERVAL_CAP_MS;
  } else {
    const quota = await provider.fetchQuotaStatus();
    const remainingQuota = quota.requestsLimitPerDay - quota.requestsUsedToday;
    const confirmationsOwed = await pendingConfirmationPassesRepository.countOwed();
    const budgetForRounds = remainingQuota - 2 * confirmationsOwed;
    const rounds = Math.max(1, Math.floor((budgetForRounds - 2 * stillLiveCount) / (1 + 2 * stillLiveCount)));
    nextDelayMs = Math.max(MIN_POLL_INTERVAL_MS, (LIVE_FIXTURE_WINDOW_MINUTES / rounds) * 60 * 1000);
  }

  await providerPollStateRepository.update(pollState.id, { nextLivePollDueAt: new Date(now.getTime() + nextDelayMs) });
  return result;
}
