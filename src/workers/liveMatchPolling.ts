import { matchesRepository, pendingConfirmationPassesRepository, providerPollStateRepository } from "../db/repositories";
import type { Match } from "../domain";
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
 * The fixtures we expected the live list to account for and it did not — the set worth spending a
 * targeted `fixtures?ids=` lookup on.
 *
 * An IN_PROGRESS match that vanished from `live=all` is the core case, and the reason this
 * function exists: the live list carries only fixtures in play, so the final whistle *removes* a
 * fixture from it rather than reporting it as FT. Acting solely on what the live list returns
 * therefore makes the IN_PROGRESS -> COMPLETED transition structurally unobservable, stalling the
 * whole scoring pipeline for that fixture until the twice-daily discovery pass heals it
 * (docs/stuck-live-match-reconciliation-plan.md).
 *
 * A SCHEDULED/DELAYED match whose kickoff is well past is the same question from the other side:
 * either it was postponed and our kickoff time is stale, or it kicked off and we never caught it
 * live. Matches with no externalId (mock/seed rows) are skipped — there is nothing to ask about.
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
      match.status === "IN_PROGRESS" ||
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

/** Whether a fixture should hold the tick on its fast live cadence. INTERRUPTED (SUSP/INT) counts
 * alongside IN_PROGRESS because an interrupted match is expected to resume, and dropping to the
 * idle interval would mean missing the restart by up to half an hour. */
function countsAsStillLiveForPacing(fixture: ProviderFixture): boolean {
  const status = mapApiFootballStatusToMatchStatus(fixture.statusShortCode);
  return status === "IN_PROGRESS" || status === "INTERRUPTED";
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
  const externalFixtureIdsToReconcile = selectExternalFixtureIdsMissingFromLiveList(potentiallyLive, liveFixtures, now);
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
