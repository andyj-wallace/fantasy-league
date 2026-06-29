import { providerPollStateRepository } from "../db/repositories";
import { runDueConfirmationPasses } from "./confirmationPasses";
import { StubFootballDataProvider, type FootballDataProvider } from "./footballDataProvider";
import { importMatchData, type ImportMatchDataResult } from "./importMatchData";
import { importPlayerAvailability } from "./importPlayerAvailability";
import { importPlayerRoster } from "./importPlayerRoster";
import { runLiveMatchPollingTick } from "./liveMatchPolling";
import { processMatchDataChanges } from "./processMatchDataChanges";

/** fetchPlayerRoster costs ~21 calls (1 /teams + 20 /players/squads) — squads don't change
 * minute-to-minute, so this runs weekly rather than daily to stay within the 100/day cap. */
const ROSTER_IMPORT_GATE_MS = 7 * 24 * 60 * 60 * 1000;
const AVAILABILITY_SYNC_GATE_MS = 24 * 60 * 60 * 1000;
/** ~1 call/gameweek per polling-budget.md; checking daily costs nothing when not due. */
const DISCOVERY_GATE_MS = 12 * 60 * 60 * 1000;

function isStale(lastRanAt: Date | null, gateMs: number, now: Date): boolean {
  return !lastRanAt || now.getTime() - lastRanAt.getTime() >= gateMs;
}

function mergeResults(a: ImportMatchDataResult, b: ImportMatchDataResult): ImportMatchDataResult {
  return {
    newlyCompletedMatchIds: [...a.newlyCompletedMatchIds, ...b.newlyCompletedMatchIds],
    newlyPostponedMatchIds: [...a.newlyPostponedMatchIds, ...b.newlyPostponedMatchIds],
  };
}

/**
 * The full poll-and-process pass: one call per scheduled trigger (every 1-5 minutes in prod).
 * Every provider-hitting step here is gated/self-throttled against providerPollState so this can
 * safely run on a short fixed cadence in both the Lambda handler and the local dev scheduler
 * without blowing the provider's 100-requests/day cap — see polling-budget.md and the "Scheduling
 * model" notes in the football-data-provider plan.
 */
export async function runWorkerCycle(provider: FootballDataProvider = new StubFootballDataProvider()): Promise<void> {
  const now = new Date();
  const pollState = await providerPollStateRepository.getOrCreate();

  if (isStale(pollState.lastRosterImportRanAt, ROSTER_IMPORT_GATE_MS, now)) {
    await importPlayerRoster(provider);
    await providerPollStateRepository.update(pollState.id, { lastRosterImportRanAt: now });
  }

  if (isStale(pollState.lastAvailabilitySyncRanAt, AVAILABILITY_SYNC_GATE_MS, now)) {
    await importPlayerAvailability(provider);
    await providerPollStateRepository.update(pollState.id, { lastAvailabilitySyncRanAt: now });
  }

  let result: ImportMatchDataResult = { newlyCompletedMatchIds: [], newlyPostponedMatchIds: [] };

  if (isStale(pollState.lastDiscoveryRanAt, DISCOVERY_GATE_MS, now)) {
    const seasonFixtures = await provider.fetchSeasonFixtures();
    result = mergeResults(result, await importMatchData(provider, seasonFixtures));
    await providerPollStateRepository.update(pollState.id, { lastDiscoveryRanAt: now });
  }

  await runDueConfirmationPasses(provider);

  result = mergeResults(result, await runLiveMatchPollingTick(provider));

  await processMatchDataChanges(result);
}
