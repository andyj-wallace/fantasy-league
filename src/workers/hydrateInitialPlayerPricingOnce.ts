import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { playersRepository } from "../db/repositories";
import { calculateInitialPriceInMillions } from "../domain";
import type { Player, PlayerPosition, PlayerSeasonStatistics } from "../domain";
import { createFootballDataProviderFromEnv } from "./createFootballDataProviderFromEnv";

/**
 * One-time, manually-triggered pre-season pricing hydration — see docs/initial-player-pricing.md.
 * Run once, after `npm run hydrate:roster`, before the season's first gameweek lock. Per
 * docs/polling-budget.md's shared-API-key risk, don't run this concurrently with
 * runWorkerCycle.ts / live-match polling — its quota bookkeeping assumes it's the only caller.
 *
 * Pass 1 (bulk): fetchAllPlayerSeasonStatistics(previousSeasonYear) pulls every Premier League
 * player's previous-season aggregate stat line in ~28 calls. Pass 2 (fallback): for any
 * current-roster player absent from that bulk pull (new signings, promoted-club players — no PL
 * data at all), fetchPlayerSeasonStatistics(externalId, previousSeasonYear) looks them up
 * individually, unscoped by league, so no "which other league did they come from" guessing is
 * needed. A player found in the bulk pull with some previous-season appearances but below
 * MINIMUM_PREVIOUS_SEASON_MINUTES_FOR_PRICING is left at the flat placeholder directly, without a
 * Pass-2 call — the fallback exists for "no PL signal at all", not to refine partial data.
 *
 * Safe to re-run: Pass 1 is deterministic (previous-season data doesn't change), and Pass 2
 * skips externalIds already recorded in the checkpoint file from a prior run.
 */

const CHECKPOINT_DIRECTORY_PATH = join(process.cwd(), "artifacts", "hydrate-initial-pricing");
const CHECKPOINT_FILE_PATH = join(CHECKPOINT_DIRECTORY_PATH, "checkpoint.json");

/** How much daily quota headroom to keep in reserve — stop Pass 2 before actually hitting zero. */
const DAILY_QUOTA_RESERVE = 5;

interface Checkpoint {
  previousSeasonYear: number;
  /** externalIds that have already had a Pass-2 fallback lookup attempted, regardless of
   * outcome — re-running the script must not re-spend a call on these. */
  attemptedFallbackExternalIds: string[];
}

async function loadCheckpoint(previousSeasonYear: number): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await readFile(CHECKPOINT_FILE_PATH, "utf8")) as Checkpoint;
    // A checkpoint from a different previous season doesn't apply here — start fresh.
    return raw.previousSeasonYear === previousSeasonYear ? new Set(raw.attemptedFallbackExternalIds) : new Set();
  } catch {
    return new Set();
  }
}

async function persistCheckpoint(previousSeasonYear: number, attemptedFallbackExternalIds: Set<string>): Promise<void> {
  await mkdir(CHECKPOINT_DIRECTORY_PATH, { recursive: true });
  const checkpoint: Checkpoint = { previousSeasonYear, attemptedFallbackExternalIds: [...attemptedFallbackExternalIds] };
  await writeFile(CHECKPOINT_FILE_PATH, JSON.stringify(checkpoint, null, 2));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPriceOrNull(position: PlayerPosition, stats: PlayerSeasonStatistics): number | null {
  return calculateInitialPriceInMillions({
    position,
    previousSeasonAppearances: stats.appearances,
    previousSeasonMinutesPlayed: stats.minutesPlayed,
    previousSeasonGoals: stats.goals,
    previousSeasonAssists: stats.assists,
    previousSeasonSaves: stats.saves,
    previousSeasonYellowCards: stats.yellowCards,
    previousSeasonRedCards: stats.redCards,
  });
}

interface HydrationSummary {
  pricedViaBulk: number;
  pricedViaFallback: number;
  leftAtPlaceholder: number;
  skippedNoExternalId: number;
  skippedAlreadyAttemptedFallback: number;
  stoppedEarlyOnQuota: boolean;
}

function summarizePricesByPosition(pricesByPosition: Record<string, number[]>): Record<string, { count: number; min: number; max: number; avg: number }> {
  const summary: Record<string, { count: number; min: number; max: number; avg: number }> = {};
  for (const [position, prices] of Object.entries(pricesByPosition)) {
    if (prices.length === 0) continue;
    summary[position] = {
      count: prices.length,
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: Math.round((prices.reduce((sum, p) => sum + p, 0) / prices.length) * 10) / 10,
    };
  }
  return summary;
}

async function main(): Promise<void> {
  const currentSeasonYear = Number(process.env.FOOTBALL_DATA_SEASON_YEAR ?? 2024);
  const previousSeasonYear = Number(process.env.PREVIOUS_SEASON_YEAR ?? currentSeasonYear - 1);
  const fallbackDelayMs = Number(process.env.FOOTBALL_DATA_REQUEST_DELAY_MS ?? 7_000);

  const provider = createFootballDataProviderFromEnv();

  const roster = await playersRepository.findMany({});
  if (roster.length === 0) {
    console.warn("WARNING: zero players in roster — run `npm run hydrate:roster` first.");
  }

  console.log(`Pass 1: bulk-pulling previous season (${previousSeasonYear}) statistics...`);
  const bulkStats = await provider.fetchAllPlayerSeasonStatistics(previousSeasonYear);
  const bulkStatsByExternalId = new Map(bulkStats.map((stats) => [stats.externalId, stats]));
  console.log(`Pass 1: found previous-season data for ${bulkStatsByExternalId.size} players.`);

  const attemptedFallbackExternalIds = await loadCheckpoint(previousSeasonYear);

  const summary: HydrationSummary = {
    pricedViaBulk: 0,
    pricedViaFallback: 0,
    leftAtPlaceholder: 0,
    skippedNoExternalId: 0,
    skippedAlreadyAttemptedFallback: 0,
    stoppedEarlyOnQuota: false,
  };
  const pricesByPosition: Record<string, number[]> = {};

  async function applyPrice(player: Player, stats: PlayerSeasonStatistics | null, source: "bulk" | "fallback"): Promise<void> {
    const price = stats ? toPriceOrNull(player.position, stats) : null;
    if (price === null) {
      summary.leftAtPlaceholder++;
      return;
    }
    await playersRepository.updatePrice(player.id, price);
    if (source === "bulk") summary.pricedViaBulk++;
    else summary.pricedViaFallback++;
    (pricesByPosition[player.position] ??= []).push(price);
  }

  console.log("Pass 2: resolving players with no previous-season Premier League data...");
  for (const player of roster) {
    if (!player.externalId) {
      summary.skippedNoExternalId++;
      continue;
    }

    const bulk = bulkStatsByExternalId.get(player.externalId);
    if (bulk && bulk.appearances > 0) {
      await applyPrice(player, bulk, "bulk");
      continue;
    }

    if (attemptedFallbackExternalIds.has(player.externalId)) {
      summary.skippedAlreadyAttemptedFallback++;
      continue;
    }

    const quota = await provider.fetchQuotaStatus();
    if (quota.requestsLimitPerDay - quota.requestsUsedToday <= DAILY_QUOTA_RESERVE) {
      console.warn("Stopping Pass 2 early — daily quota nearly exhausted. Re-run later to resume from checkpoint.");
      summary.stoppedEarlyOnQuota = true;
      break;
    }

    const fallback = await provider.fetchPlayerSeasonStatistics(player.externalId, previousSeasonYear);
    await applyPrice(player, fallback, "fallback");
    attemptedFallbackExternalIds.add(player.externalId);
    await persistCheckpoint(previousSeasonYear, attemptedFallbackExternalIds);
    await delay(fallbackDelayMs);
  }

  console.log(
    JSON.stringify(
      { summary, priceStatsByPosition: summarizePricesByPosition(pricesByPosition) },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
