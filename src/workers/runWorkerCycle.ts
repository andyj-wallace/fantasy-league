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
/** /leagues call to resolve the current season year and coverage flags. Monthly is plenty for the
 * season *year*, which changes once a season. */
const SEASON_SYNC_GATE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * ...but monthly is badly wrong for the *coverage flags* that ride along on the same call, which
 * is why this second, much shorter gate exists.
 *
 * Coverage flips false→true exactly once, when the provider starts populating a new season — and
 * a sync that lands in the hours just before that flip pins us to `false` until the monthly gate
 * next opens. That is not a degraded mode: coverageFixturePlayerStats gates
 * fetchFixturePlayerStatsAndGoalEvents, and importMatchData fetches a match's stats *only* on its
 * transition into COMPLETED, so every match completing inside that window loses its stats
 * permanently and scores zero for everyone. Exactly that happened on 2026-08-24: a sync 18 hours
 * before the season's first kickoff read `statistics_players: false`, and all ten Gameweek 1
 * matches completed unscored (see DEPLOYMENT_RUNBOOK.md and backfillMissingMatchStatsAndScores.ts).
 *
 * So while any flag is still false, re-check hourly instead: /leagues is a single call — ~24/day
 * against a 7,500/day Pro budget — and it stops the moment coverage comes back true.
 */
const SEASON_SYNC_GATE_WHILE_COVERAGE_INCOMPLETE_MS = 60 * 60 * 1000;
/** Roster import costs ~21 calls — skip it when the daily budget is this tight. */
const MINIMUM_QUOTA_FOR_ROSTER_IMPORT = 25;

function isStale(lastRanAt: Date | null, gateMs: number, now: Date): boolean {
  return !lastRanAt || now.getTime() - lastRanAt.getTime() >= gateMs;
}

/** Both tracked flags gate real work — fixture player stats drive all scoring, injuries drive
 * availability — so either one being false means the last sync's answer is worth re-asking soon. */
function hasProviderConfirmedFullCoverage(pollState: {
  coverageFixturePlayerStats: boolean;
  coverageInjuries: boolean;
}): boolean {
  return pollState.coverageFixturePlayerStats && pollState.coverageInjuries;
}

function mergeResults(a: ImportMatchDataResult, b: ImportMatchDataResult): ImportMatchDataResult {
  return {
    newlyCompletedMatchIds: [...a.newlyCompletedMatchIds, ...b.newlyCompletedMatchIds],
    newlyDisruptedMatchIds: [...a.newlyDisruptedMatchIds, ...b.newlyDisruptedMatchIds],
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
  console.log(`[worker] cycle start ${now.toISOString()}`);

  // /status is free and not counted against the daily limit — safe to call every cycle.
  const quota = await provider.fetchQuotaStatus();
  const remainingQuota = quota.requestsLimitPerDay - quota.requestsUsedToday;
  console.log(`[worker] quota: ${quota.requestsUsedToday}/${quota.requestsLimitPerDay} used today, ${remainingQuota} remaining`);

  const pollState = await providerPollStateRepository.getOrCreate();

  // Seed the provider's active season from the DB so coverage gates work from the first cycle.
  if (pollState.currentSeasonYear !== null) {
    provider.setCurrentSeason(pollState.currentSeasonYear, {
      fixturePlayerStats: pollState.coverageFixturePlayerStats,
      injuries: pollState.coverageInjuries,
    });
  }

  // Season sync — resolves the current PL season year + coverage from /leagues. Monthly once the
  // provider has confirmed full coverage, hourly until then (see the gate constants above).
  const seasonSyncGateMs = hasProviderConfirmedFullCoverage(pollState)
    ? SEASON_SYNC_GATE_MS
    : SEASON_SYNC_GATE_WHILE_COVERAGE_INCOMPLETE_MS;
  if (isStale(pollState.lastSeasonSyncRanAt, seasonSyncGateMs, now)) {
    console.log("[worker] season sync due — fetching league info");
    const seasonInfo = await provider.fetchLeagueCurrentSeason();
    if (seasonInfo) {
      provider.setCurrentSeason(seasonInfo.seasonYear, {
        fixturePlayerStats: seasonInfo.coverageFixturePlayerStats,
        injuries: seasonInfo.coverageInjuries,
      });
      await providerPollStateRepository.update(pollState.id, {
        currentSeasonYear: seasonInfo.seasonYear,
        coverageFixturePlayerStats: seasonInfo.coverageFixturePlayerStats,
        coverageInjuries: seasonInfo.coverageInjuries,
        lastSeasonSyncRanAt: now,
      });
      console.log(`[worker] season sync: year=${seasonInfo.seasonYear}, fixture_stats=${seasonInfo.coverageFixturePlayerStats}, injuries=${seasonInfo.coverageInjuries}`);
    } else {
      console.log("[worker] season sync: provider returned null — keeping existing season config");
      await providerPollStateRepository.update(pollState.id, { lastSeasonSyncRanAt: now });
    }
  } else {
    console.log("[worker] season sync skipped (not stale)");
  }

  if (isStale(pollState.lastRosterImportRanAt, ROSTER_IMPORT_GATE_MS, now)) {
    if (remainingQuota < MINIMUM_QUOTA_FOR_ROSTER_IMPORT) {
      console.log(`[worker] roster import skipped — only ${remainingQuota} calls remaining (need ${MINIMUM_QUOTA_FOR_ROSTER_IMPORT})`);
    } else {
      console.log("[worker] roster import due — running");
      await importPlayerRoster(provider);
      await providerPollStateRepository.update(pollState.id, { lastRosterImportRanAt: now });
    }
  } else {
    console.log("[worker] roster import skipped (not stale)");
  }

  if (isStale(pollState.lastAvailabilitySyncRanAt, AVAILABILITY_SYNC_GATE_MS, now)) {
    console.log("[worker] availability sync due — running");
    await importPlayerAvailability(provider);
    await providerPollStateRepository.update(pollState.id, { lastAvailabilitySyncRanAt: now });
  } else {
    console.log("[worker] availability sync skipped (not stale)");
  }

  let result: ImportMatchDataResult = { newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [] };

  if (isStale(pollState.lastDiscoveryRanAt, DISCOVERY_GATE_MS, now)) {
    console.log("[worker] discovery due — fetching season fixtures");
    const seasonFixtures = await provider.fetchSeasonFixtures();
    console.log(`[worker] discovery fetched ${seasonFixtures.length} fixtures`);
    result = mergeResults(result, await importMatchData(provider, seasonFixtures));
    await providerPollStateRepository.update(pollState.id, { lastDiscoveryRanAt: now });
  } else {
    console.log("[worker] discovery skipped (not stale)");
  }

  await runDueConfirmationPasses(provider);

  result = mergeResults(result, await runLiveMatchPollingTick(provider));

  await processMatchDataChanges(result);
  console.log(`[worker] cycle complete — ${result.newlyCompletedMatchIds.length} completed, ${result.newlyDisruptedMatchIds.length} disrupted`);
}
