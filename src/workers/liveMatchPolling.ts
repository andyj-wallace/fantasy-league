import { matchesRepository, pendingConfirmationPassesRepository, providerPollStateRepository } from "../db/repositories";
import {
  MATCH_POLLING_ABANDONMENT_WINDOW_MS,
  MATCH_STATUSES_UNDER_WAY_BUT_NOT_YET_RESOLVED,
  partitionMatchesByPollingAbandonmentWindow,
  type Match,
} from "../domain";
import {
  MAX_FIXTURE_IDS_PER_PROVIDER_REQUEST,
  type FootballDataProvider,
  type ProviderFixture,
} from "./footballDataProvider";
import { mapApiFootballStatusToMatchStatus } from "./footballMatchStatusMapping";
import { importMatchData, type ImportMatchDataResult } from "./importMatchData";

/** A fixture's live window: 90 min plus stoppage/halftime; no extra time in league play. */
const LIVE_FIXTURE_WINDOW_MINUTES = 110;
/** No point outpacing the provider's own update cycle. */
const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Cadence (and ceiling on "wake for the next kickoff") when nothing is currently live. */
const IDLE_POLL_INTERVAL_CAP_MS = 30 * 60 * 1000;
/** How far past its kickoff a fixture we've never seen in play has to be before we ask the
 * provider about it by name. Around kickoff the live list routinely lags our stored kickoff time
 * by a few minutes, and chasing that lag would spend a request on every fixture at every 3pm. */
const MISSING_KICKOFF_GRACE_MS = 15 * 60 * 1000;

const NO_OP_RESULT: ImportMatchDataResult = { newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [] };

/**
 * Says out loud which fixtures the poller has stopped chasing, so an abandoned row shows up in
 * CloudWatch rather than rotting silently — it still blocks its gameweek from completing
 * (its status is still one of MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION), it is just no
 * longer the poller's problem.
 *
 * This is the whole reason findPotentiallyLive does not apply the window itself: a row it filtered
 * out in SQL could never be reported, and a permanently stuck fixture would go from loud (burning
 * ~96 provider calls a day) to entirely silent — while still blocking its gameweek. Discovery is the
 * safety net, but discovery only heals a row the provider still returns in its season list, and the
 * case that motivated the window is precisely a fixture the provider has dropped. So this line is
 * the last signal that such a row exists.
 */
function warnAboutMatchesAbandonedLongAfterKickoff(abandonedMatches: Match[]): void {
  if (abandonedMatches.length === 0) return;
  const abandonmentWindowHours = MATCH_POLLING_ABANDONMENT_WINDOW_MS / (60 * 60 * 1000);
  const describedMatches = abandonedMatches
    .map((match) => `${match.id} (${match.status}, kickoff ${match.kickoffAt.toISOString()})`)
    .join(", ");
  console.warn(
    `[liveMatchPolling] no longer polling ${abandonedMatches.length} non-terminal match(es) more than ` +
      `${abandonmentWindowHours}h past kickoff — the twice-daily discovery pass owns them now: ${describedMatches}`,
  );
}

/**
 * The fixtures we expected the live list to account for and it did not — the set worth spending a
 * targeted `fixtures?ids=` lookup on.
 *
 * A match already under way (IN_PROGRESS or INTERRUPTED) that vanished from `live=all` is the core
 * case, and the reason this function exists: the live list carries only fixtures in play, so the
 * final whistle *removes* a fixture from it rather than reporting it as FT. Acting solely on what the live list returns
 * therefore makes the IN_PROGRESS -> COMPLETED transition structurally unobservable, stalling the
 * whole scoring pipeline for that fixture until the twice-daily discovery pass heals it
 * (docs/stuck-live-match-reconciliation-plan.md).
 *
 * A SCHEDULED/DELAYED match whose kickoff is well past is the same question from the other side:
 * either it was postponed and our kickoff time is stale, or it kicked off and we never caught it
 * live. Matches with no externalId (mock/seed rows) are skipped — there is nothing to ask about.
 *
 * MISSING_KICKOFF_GRACE_MS is only the near bound on "well past". The far bound is
 * MATCH_POLLING_ABANDONMENT_WINDOW_MS, already applied by the caller: this function never sees a row
 * older than that, so it cannot re-ask about a fixture the poller has given up on. Re-applying the
 * window here would be a branch no caller can reach and no test can distinguish — it is enforced
 * once, up front, where it also spares the live-list call.
 */
function selectExternalFixtureIdsMissingFromLiveList(
  potentiallyLiveMatches: Match[],
  liveFixtures: ProviderFixture[],
  now: Date,
): string[] {
  const externalIdsReturnedByLiveList = new Set(liveFixtures.map((fixture) => fixture.externalId));
  const externalFixtureIdsToReconcile: string[] = [];

  for (const match of potentiallyLiveMatches) {
    if (!match.externalId) continue;
    if (externalIdsReturnedByLiveList.has(match.externalId)) continue;

    const hasBeenMissingSinceWellAfterKickoff = now.getTime() - match.kickoffAt.getTime() > MISSING_KICKOFF_GRACE_MS;
    const isWorthReconciling =
      MATCH_STATUSES_UNDER_WAY_BUT_NOT_YET_RESOLVED.includes(match.status) ||
      ((match.status === "SCHEDULED" || match.status === "DELAYED") && hasBeenMissingSinceWellAfterKickoff);
    if (isWorthReconciling) externalFixtureIdsToReconcile.push(match.externalId);
  }

  return externalFixtureIdsToReconcile;
}

/**
 * Reconciliation is a repair pass bolted onto the tick, not the tick's purpose: if the targeted
 * lookup fails, the live list's fixtures must still import and the next poll must still be
 * scheduled. Degrading to an empty result costs nothing but one more poll interval — the matches
 * stay IN_PROGRESS and are reconciled again on the next tick — whereas letting the error out
 * would abandon the live fixtures mid-cycle and leave nextLivePollDueAt un-advanced.
 */
async function fetchReconciliationFixturesOrDegrade(
  provider: FootballDataProvider,
  externalFixtureIdsToReconcile: string[],
): Promise<ProviderFixture[]> {
  if (externalFixtureIdsToReconcile.length === 0) return [];
  try {
    return await provider.fetchFixturesByExternalIds(externalFixtureIdsToReconcile);
  } catch (error) {
    console.warn(
      `[liveMatchPolling] reconciliation lookup failed for ${externalFixtureIdsToReconcile.length} fixture(s) — ` +
        "importing the live list alone and retrying them on the next tick",
      error,
    );
    return [];
  }
}

/** Whether a fixture should hold the tick on its fast live cadence — the same "under way, not yet
 * resolved" rule that decides which fixtures get reconciled, so the tick cannot both pace for a
 * fixture and refuse to chase it. Dropping an INTERRUPTED fixture to the idle interval would mean
 * missing its restart by up to half an hour. */
function countsAsStillLiveForPacing(fixture: ProviderFixture): boolean {
  const status = mapApiFootballStatusToMatchStatus(fixture.statusShortCode);
  return MATCH_STATUSES_UNDER_WAY_BUT_NOT_YET_RESOLVED.includes(status);
}

/**
 * Self-throttling adaptive live-tracking tick from the Live-Match Polling Strategy in
 * Fantasy League Architecture.txt / docs/polling-budget.md. No-ops (cheap DB read only) unless
 * providerPollState.nextLivePollDueAt has passed, so it's safe to call on every worker cycle
 * regardless of how often that cycle runs.
 *
 * Each poll asks the provider two questions: the broad "what is in play right now" live list, and
 * — only when some match we believe is live is missing from that answer — a targeted lookup of
 * those fixtures by id. The two sets are imported together, because a fixture that left the live
 * list has usually just finished and importMatchData's FT handling is exactly what has to run for
 * it (see selectExternalFixtureIdsMissingFromLiveList).
 */
export async function runLiveMatchPollingTick(provider: FootballDataProvider): Promise<ImportMatchDataResult> {
  const pollState = await providerPollStateRepository.getOrCreate();
  const now = new Date();
  if (pollState.nextLivePollDueAt && pollState.nextLivePollDueAt > now) {
    return NO_OP_RESULT;
  }

  // The abandonment window is enforced here and only here — findPotentiallyLive deliberately hands
  // back stale rows so they can be reported before being dropped. It has to sit above the length
  // check, because that check is what arms the tick: a row past the window reaching it would stop
  // the zero-call early return below from ever firing, and the tick would pay for a live list every
  // idle interval forever.
  const potentiallyLive = await matchesRepository.findPotentiallyLive(now);
  const { stillWithinPollingWindow, abandonedLongAfterKickoff } = partitionMatchesByPollingAbandonmentWindow(
    potentiallyLive,
    now,
  );
  warnAboutMatchesAbandonedLongAfterKickoff(abandonedLongAfterKickoff);

  if (stillWithinPollingWindow.length === 0) {
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
  const externalFixtureIdsToReconcile = selectExternalFixtureIdsMissingFromLiveList(
    stillWithinPollingWindow,
    liveFixtures,
    now,
  );
  const reconciledFixtures = await fetchReconciliationFixturesOrDegrade(provider, externalFixtureIdsToReconcile);
  if (externalFixtureIdsToReconcile.length > 0) {
    console.log(
      `[liveMatchPolling] ${externalFixtureIdsToReconcile.length} match(es) missing from the live list — ` +
        `reconciled ${reconciledFixtures.length} by id`,
    );
  }

  const fixturesToImport = [...liveFixtures, ...reconciledFixtures];
  const result = await importMatchData(provider, fixturesToImport);

  // Pace off the MERGED set, never the live list alone: a fixture the provider momentarily dropped
  // from `live=all` comes back through reconciliation still in play, and counting only the live
  // list would collapse the cadence to the idle interval for the rest of that match.
  const stillLiveCount = fixturesToImport.filter(countsAsStillLiveForPacing).length;

  let nextDelayMs: number;
  if (stillLiveCount === 0) {
    // Note a live-list-empty tick whose reconciliation lookup *failed* lands here too, degrading
    // the very fixtures it was trying to repair to the 30-minute idle cadence — the same collapse
    // reconciliation exists to prevent, just one interval deep and self-correcting on the next
    // tick. Pinned by liveMatchPolling.test.ts rather than worked around; see the plan doc.
    nextDelayMs = IDLE_POLL_INTERVAL_CAP_MS;
  } else {
    const quota = await provider.fetchQuotaStatus();
    const remainingQuota = quota.requestsLimitPerDay - quota.requestsUsedToday;
    const confirmationsOwed = await pendingConfirmationPassesRepository.countOwed();
    const budgetForRounds = remainingQuota - 2 * confirmationsOwed;
    // Per round: the one live-list call, the reconciliation lookups this round needed (a fair
    // projection of the next round's, and zero on the common path where nothing went missing),
    // and the events+players pair for each fixture still live.
    const reconciliationRequestsPerRound = Math.ceil(
      externalFixtureIdsToReconcile.length / MAX_FIXTURE_IDS_PER_PROVIDER_REQUEST,
    );
    const requestsPerRound = 1 + reconciliationRequestsPerRound + 2 * stillLiveCount;
    const rounds = Math.max(1, Math.floor((budgetForRounds - 2 * stillLiveCount) / requestsPerRound));
    nextDelayMs = Math.max(MIN_POLL_INTERVAL_MS, (LIVE_FIXTURE_WINDOW_MINUTES / rounds) * 60 * 1000);
  }

  await providerPollStateRepository.update(pollState.id, { nextLivePollDueAt: new Date(now.getTime() + nextDelayMs) });
  return result;
}
