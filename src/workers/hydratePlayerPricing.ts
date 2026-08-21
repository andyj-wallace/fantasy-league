import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { playersRepository } from "../db/repositories";
import {
  DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION,
  MEASURED_HYDRATION_CALL_COST_ESTIMATES,
  PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID,
  calculateInitialPriceInMillions,
  getLeagueStrengthMultiplier,
  planUnpricedPlayerHydration,
  selectPrimaryDomesticLeagueEntry,
} from "../domain";
import type { Player, PlayerSeasonStatistics, UnpricedPlayerHydrationCandidate } from "../domain";
import { createFootballDataProviderFromEnv } from "./createFootballDataProviderFromEnv";
import type { FootballDataProvider } from "./footballDataProvider";

/**
 * Prices every player still sitting at his position's flat placeholder — `npm run hydrate:pricing`.
 * One command for the whole job: the pre-season pass over a freshly imported roster, and the
 * repeat passes during a transfer window that catch promoted-club squads and incoming signings.
 * (It absorbs the retired `hydrate:initial-pricing`, whose Premier-League-only bulk pull could
 * price returning players and nobody else — see docs/new-player-pricing.md.)
 *
 * Five phases, in order, and the third is the one the command exists for:
 *
 *   1. **Tally**   — who is still unpriced, and which club each of them plays for now.
 *   2. **Plan**    — the cheapest mix of pulls that covers them (domain/hydrationCostModel.ts).
 *   3. **Preview** — print the tally and the projected call count, then stop unless `--yes`.
 *   4. **Execute** — run the plan.
 *   5. **Report**  — summary plus the source-league distribution, persisted for the next run.
 *
 * The provider is on a Pro plan: 7,500 calls/day with a 300/min cap, so a ~250-call hydration is
 * about 3% of a day and the binding constraint is per-minute pacing, not daily quota. The preview
 * is therefore about operator confidence rather than thrift — nobody should have to run this and
 * find out afterwards what it cost.
 *
 * Pricing a player who has never played in the Premier League means reading a stat line from
 * whatever league he did play in, which needs two corrections the Premier-League-only path never
 * did: picking his primary *domestic* league out of a competition list that also holds cups and
 * international tournaments, and discounting that league's output against the Premier League (see
 * domain/leagueStrength.ts).
 *
 * Two properties make repeat runs safe, and both matter:
 *
 * 1. It only ever writes to players still at the flat placeholder price. Established players have
 *    prices that move during the season (playerPricing.ts's form/ownership formula), and a
 *    re-pricing pass that overwrote those would silently undo weeks of in-season movement.
 * 2. Every pull is checkpointed — individual lookups by player, bulk pulls by club and by league —
 *    so a second run in the same window spends calls only on players who genuinely arrived since
 *    the last one.
 *
 * Per docs/polling-budget.md's shared-API-key risk, don't run this while live-match polling is
 * also hitting the same key.
 */

/** Kept at the name the `hydrate:new-players` era used so existing checkpoints — several hundred
 * already-spent individual lookups — keep applying to the renamed command. */
const CHECKPOINT_DIRECTORY_PATH = join(process.cwd(), "artifacts", "hydrate-new-player-pricing");
const CHECKPOINT_FILE_PATH = join(CHECKPOINT_DIRECTORY_PATH, "checkpoint.json");
const DOMESTIC_LEAGUE_CACHE_FILE_PATH = join(CHECKPOINT_DIRECTORY_PATH, "domestic-league-ids.json");

/** How much daily quota headroom to keep in reserve — stop before actually hitting zero. */
const DAILY_QUOTA_RESERVE = 5;

/** Where a previous run found one club's players' previous season. Persisted so the next run's
 * Plan phase can pre-bulk clusters it already knows about instead of rediscovering them one
 * lookup at a time. */
interface SourceLeagueTallyEntry {
  clubName: string;
  leagueId: number;
  leagueName: string;
  playerCount: number;
}

interface PricingCheckpoint {
  previousSeasonYear: number;
  /** externalIds already looked up individually, regardless of outcome — a re-run must not
   * re-spend a call on a player the provider had nothing useful for. */
  attemptedIndividualLookupExternalIds: string[];
  /** externalIds a bulk pull already produced a previous-season stat line for, including the ones
   * whose line fell below the minutes threshold and left them at the placeholder. Previous-season
   * data does not change, so that is a final answer about them — without remembering it, the next
   * run would see them still unpriced and pay for an individual lookup per head to be told the
   * same thing. */
  resolvedByBulkPullExternalIds: string[];
  /** Clubs already pulled in bulk for this season, so a re-run reuses the conclusion rather than
   * re-paying for the same pages. Keyed by club name, which is what Player rows carry. */
  bulkPulledClubNames: string[];
  /** Leagues already pulled in bulk for this season — the same reasoning, one tier up. */
  bulkPulledLeagueIds: number[];
  sourceLeagueTally: SourceLeagueTallyEntry[];
}

function emptyCheckpoint(previousSeasonYear: number): PricingCheckpoint {
  return {
    previousSeasonYear,
    attemptedIndividualLookupExternalIds: [],
    resolvedByBulkPullExternalIds: [],
    bulkPulledClubNames: [],
    bulkPulledLeagueIds: [],
    sourceLeagueTally: [],
  };
}

async function loadCheckpoint(previousSeasonYear: number): Promise<PricingCheckpoint> {
  try {
    const raw = JSON.parse(await readFile(CHECKPOINT_FILE_PATH, "utf8")) as Partial<PricingCheckpoint>;
    // A checkpoint from a different previous season describes a different question — start fresh.
    if (raw.previousSeasonYear !== previousSeasonYear) return emptyCheckpoint(previousSeasonYear);
    return {
      previousSeasonYear,
      attemptedIndividualLookupExternalIds: raw.attemptedIndividualLookupExternalIds ?? [],
      resolvedByBulkPullExternalIds: raw.resolvedByBulkPullExternalIds ?? [],
      bulkPulledClubNames: raw.bulkPulledClubNames ?? [],
      bulkPulledLeagueIds: raw.bulkPulledLeagueIds ?? [],
      sourceLeagueTally: raw.sourceLeagueTally ?? [],
    };
  } catch {
    return emptyCheckpoint(previousSeasonYear);
  }
}

async function persistCheckpoint(checkpoint: PricingCheckpoint): Promise<void> {
  await mkdir(CHECKPOINT_DIRECTORY_PATH, { recursive: true });
  await writeFile(CHECKPOINT_FILE_PATH, JSON.stringify(checkpoint, null, 2));
}

/** Domestic-league ids change only when the provider adds a competition, so this is cached to disk
 * and the one call it costs is paid once per environment rather than once per run. */
async function loadDomesticLeagueIds(provider: FootballDataProvider): Promise<Set<number>> {
  try {
    const cached = JSON.parse(await readFile(DOMESTIC_LEAGUE_CACHE_FILE_PATH, "utf8")) as number[];
    if (Array.isArray(cached) && cached.length > 0) {
      console.log(`Reference data: ${cached.length} domestic leagues (cached, 0 calls).`);
      return new Set(cached);
    }
  } catch {
    // No usable cache — fall through and fetch.
  }
  const leagueIds = await provider.fetchDomesticLeagueIds();
  await mkdir(CHECKPOINT_DIRECTORY_PATH, { recursive: true });
  await writeFile(DOMESTIC_LEAGUE_CACHE_FILE_PATH, JSON.stringify([...leagueIds]));
  console.log(`Reference data: ${leagueIds.size} domestic leagues (fetched, 1 call).`);
  return leagueIds;
}

/** The league's twenty clubs for one season, cached per season. Two seasons are needed: the
 * current one to turn a Player's club name into the team id a per-club bulk pull needs, and the
 * previous one to know which clubs were in the league then — the signal that says a club's players
 * are expected to turn up in the previous season's league-wide pull. */
async function loadLeagueTeamsForSeason(
  provider: FootballDataProvider,
  seasonYear: number,
): Promise<Map<string, string>> {
  const cacheFilePath = join(CHECKPOINT_DIRECTORY_PATH, `league-teams-${seasonYear}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFilePath, "utf8")) as [string, string][];
    if (Array.isArray(cached) && cached.length > 0) {
      console.log(`Reference data: ${cached.length} clubs in season ${seasonYear} (cached, 0 calls).`);
      return new Map(cached);
    }
  } catch {
    // No usable cache — fall through and fetch.
  }
  const teams = await provider.fetchLeagueTeams(seasonYear);
  const teamExternalIdByClubName = teams.map((team) => [team.name, team.externalId] as [string, string]);
  await mkdir(CHECKPOINT_DIRECTORY_PATH, { recursive: true });
  await writeFile(cacheFilePath, JSON.stringify(teamExternalIdByClubName));
  console.log(`Reference data: ${teams.length} clubs in season ${seasonYear} (fetched, 1 call).`);
  return new Map(teamExternalIdByClubName);
}

function isStillAtPlaceholderPrice(player: Player): boolean {
  return player.priceInMillions === DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION[player.position];
}

/** The league a club's players most often turned out to have come from on previous runs. Ties go
 * to the larger count and then to the lower league id, so the answer is stable across runs. */
function buildMostCommonSourceLeagueIdByClubName(tally: readonly SourceLeagueTallyEntry[]): Map<string, number> {
  const bestByClubName = new Map<string, SourceLeagueTallyEntry>();
  for (const entry of [...tally].sort((a, b) => b.playerCount - a.playerCount || a.leagueId - b.leagueId)) {
    if (!bestByClubName.has(entry.clubName)) bestByClubName.set(entry.clubName, entry);
  }
  return new Map([...bestByClubName].map(([clubName, entry]) => [clubName, entry.leagueId]));
}

interface HydrationSummary {
  unpricedAtStart: number;
  candidatesPlanned: number;
  leaguesBulkPulled: number;
  clubsBulkPulled: number;
  pricedViaLeagueBulk: number;
  pricedViaClubBulk: number;
  pricedViaIndividualLookup: number;
  individualLookupsSpent: number;
  leftAtPlaceholderNoDomesticLeague: number;
  leftAtPlaceholderBelowMinutesThreshold: number;
  skippedNonNumericExternalId: number;
  skippedNoExternalId: number;
  skippedAlreadyAttempted: number;
  stoppedEarlyOnQuota: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRequiredSeasonYearFromEnvironment(variableName: string, why: string): number {
  const raw = process.env[variableName];
  if (!raw || !/^\d{4}$/.test(raw)) {
    throw new Error(`${variableName} must be set to a four-digit season year. ${why}`);
  }
  return Number(raw);
}

async function main(): Promise<void> {
  const hasConfirmedSpend = process.argv.slice(2).includes("--yes");

  const currentSeasonYear = readRequiredSeasonYearFromEnvironment(
    "FOOTBALL_DATA_SEASON_YEAR",
    "It names the season the imported roster belongs to, which is how a player's club name is " +
      "resolved to the team id a per-club bulk pull needs.",
  );
  // Deliberately not defaulted to currentSeasonYear - 1: that default is right in August and wrong
  // in January, when a winter-window run still wants the same completed season the summer run used.
  const previousSeasonYear = readRequiredSeasonYearFromEnvironment(
    "PREVIOUS_SEASON_YEAR",
    "It names the completed season players are priced from, and the right answer in a winter " +
      "window is the same season the summer run used — not the one before it.",
  );
  const requestDelayMs = Number(process.env.FOOTBALL_DATA_REQUEST_DELAY_MS ?? 7_000);

  const provider = createFootballDataProviderFromEnv();

  // ---- Phase 0: reference data. Cached to disk, so this is free on every run after the first.
  const domesticLeagueIds = await loadDomesticLeagueIds(provider);
  const teamExternalIdByCurrentClubName = await loadLeagueTeamsForSeason(provider, currentSeasonYear);
  const clubNamesInLeagueLastSeason = new Set(
    (await loadLeagueTeamsForSeason(provider, previousSeasonYear)).keys(),
  );

  const checkpoint = await loadCheckpoint(previousSeasonYear);
  const attemptedIndividualLookups = new Set(checkpoint.attemptedIndividualLookupExternalIds);
  const resolvedByBulkPull = new Set(checkpoint.resolvedByBulkPullExternalIds);
  const bulkPulledClubNames = new Set(checkpoint.bulkPulledClubNames);
  const bulkPulledLeagueIds = new Set(checkpoint.bulkPulledLeagueIds);
  const mostCommonSourceLeagueIdByClubName = buildMostCommonSourceLeagueIdByClubName(checkpoint.sourceLeagueTally);

  // ---- Phase 1: tally. Only players a roster import last saw in a current squad: a hidden
  // player is one nobody can pick, so a price for him is a call spent on nothing. If he transfers
  // back in, the import that un-hides him puts him back in this cohort.
  const roster = await playersRepository.findMany({ onlyInCurrentSeasonSquad: true });
  const unpriced = roster.filter(isStillAtPlaceholderPrice);

  const summary: HydrationSummary = {
    unpricedAtStart: unpriced.length,
    candidatesPlanned: 0,
    leaguesBulkPulled: 0,
    clubsBulkPulled: 0,
    pricedViaLeagueBulk: 0,
    pricedViaClubBulk: 0,
    pricedViaIndividualLookup: 0,
    individualLookupsSpent: 0,
    leftAtPlaceholderNoDomesticLeague: 0,
    leftAtPlaceholderBelowMinutesThreshold: 0,
    skippedNonNumericExternalId: 0,
    skippedNoExternalId: 0,
    skippedAlreadyAttempted: 0,
    stoppedEarlyOnQuota: false,
  };

  const playersToPrice = unpriced.filter((player) => {
    if (!player.externalId) {
      summary.skippedNoExternalId++;
      return false;
    }
    // Local dev/test rows carry placeholder ids like "mock-player-01"; the provider rejects a
    // non-integer id outright.
    if (!/^\d+$/.test(player.externalId)) {
      summary.skippedNonNumericExternalId++;
      return false;
    }
    // Two ways to already have the answer, and both are final for this previous season: an
    // unscoped individual lookup is the most informative pull there is, so a player it failed on
    // is not going to be rescued by a bulk pull; and a bulk pull that did find him has told us
    // everything the season holds about him, placeholder outcome included.
    if (attemptedIndividualLookups.has(player.externalId) || resolvedByBulkPull.has(player.externalId)) {
      summary.skippedAlreadyAttempted++;
      return false;
    }
    return true;
  });
  summary.candidatesPlanned = playersToPrice.length;

  const unpricedCountByClubName = new Map<string, number>();
  for (const player of playersToPrice) {
    unpricedCountByClubName.set(player.club, (unpricedCountByClubName.get(player.club) ?? 0) + 1);
  }

  console.log(
    `Tally: ${unpriced.length} of ${roster.length} players in the current season's squads are still at ` +
      `their position's placeholder price; ` +
      `${playersToPrice.length} of those are worth a pull, across ${unpricedCountByClubName.size} clubs. ` +
      `Pricing from season ${previousSeasonYear}.`,
  );

  // ---- Phase 2: plan.
  const candidates: UnpricedPlayerHydrationCandidate[] = playersToPrice.map((player) => ({
    playerExternalId: player.externalId!,
    currentClubName: player.club,
    expectedPreviousSeasonLeagueId: clubNamesInLeagueLastSeason.has(player.club)
      ? PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID
      : mostCommonSourceLeagueIdByClubName.get(player.club) ?? null,
  }));

  const plan = planUnpricedPlayerHydration(candidates, MEASURED_HYDRATION_CALL_COST_ESTIMATES, {
    clubNames: bulkPulledClubNames,
    leagueIds: bulkPulledLeagueIds,
  });

  // A bulk pull is a projection of calls, not a promise of coverage: an incoming transfer sitting
  // at a bulk-pulled club was somewhere else last season and falls through to an individual
  // lookup. So the plan's figure is a floor, and this is the ceiling.
  const bulkPullCallCost = plan.projectedTotalCallCost - plan.individualLookupPlayerExternalIds.length;
  const worstCaseCallCost = bulkPullCallCost + candidates.length;

  // ---- Phase 3: preview.
  console.log("\nPlan:");
  for (const leagueBulkPull of plan.leagueBulkPulls) {
    console.log(
      `  league bulk   league ${leagueBulkPull.leagueId} — ~${leagueBulkPull.callCost} calls, ` +
        `expected to cover ${leagueBulkPull.playerExternalIds.length} players`,
    );
  }
  for (const clubBulkPull of plan.clubBulkPulls) {
    console.log(
      `  club bulk     ${clubBulkPull.clubName} — ~${clubBulkPull.callCost} calls, ` +
        `${clubBulkPull.playerExternalIds.length} unpriced players`,
    );
  }
  console.log(`  individual    ${plan.individualLookupPlayerExternalIds.length} players at 1 call each`);
  console.log(
    `\nProjected cost: ~${plan.projectedTotalCallCost} calls ` +
      `(up to ~${worstCaseCallCost} if every bulk pull misses everyone it was expected to cover).`,
  );
  if (summary.skippedAlreadyAttempted > 0) {
    console.log(`${summary.skippedAlreadyAttempted} players were already looked up on an earlier run and are skipped.`);
  }

  if (!hasConfirmedSpend) {
    console.log("\nPreview only — nothing was spent beyond the cached reference data above. Re-run with --yes to execute.");
    return;
  }
  if (plan.projectedTotalCallCost === 0) {
    console.log("\nNothing left to price.");
    return;
  }

  // ---- Phase 4: execute.
  const sourceLeagueTally = [...checkpoint.sourceLeagueTally];
  const pricedLeagueNameCounts: Record<string, number> = {};

  function recordSourceLeague(player: Player, statLine: PlayerSeasonStatistics): void {
    pricedLeagueNameCounts[statLine.leagueName] = (pricedLeagueNameCounts[statLine.leagueName] ?? 0) + 1;
    if (statLine.leagueId === null) return;
    const existing = sourceLeagueTally.find(
      (entry) => entry.clubName === player.club && entry.leagueId === statLine.leagueId,
    );
    if (existing) existing.playerCount++;
    else
      sourceLeagueTally.push({
        clubName: player.club,
        leagueId: statLine.leagueId,
        leagueName: statLine.leagueName,
        playerCount: 1,
      });
  }

  /** Applies a stat line if it is good enough to price from, weighted by its league's strength. */
  async function applyPriceFromStatLine(
    player: Player,
    statLine: PlayerSeasonStatistics,
    source: "leagueBulk" | "clubBulk" | "individual",
  ): Promise<void> {
    const price = calculateInitialPriceInMillions({
      position: player.position,
      previousSeasonAppearances: statLine.appearances,
      previousSeasonMinutesPlayed: statLine.minutesPlayed,
      previousSeasonGoals: statLine.goals,
      previousSeasonAssists: statLine.assists,
      previousSeasonSaves: statLine.saves,
      previousSeasonYellowCards: statLine.yellowCards,
      previousSeasonRedCards: statLine.redCards,
      leagueStrengthMultiplier: getLeagueStrengthMultiplier(statLine.leagueId),
    });
    if (price === null) {
      summary.leftAtPlaceholderBelowMinutesThreshold++;
      return;
    }
    await playersRepository.updatePrice(player.id, price);
    recordSourceLeague(player, statLine);
    if (source === "leagueBulk") summary.pricedViaLeagueBulk++;
    else if (source === "clubBulk") summary.pricedViaClubBulk++;
    else summary.pricedViaIndividualLookup++;
  }

  const playersByExternalId = new Map(playersToPrice.map((player) => [player.externalId!, player]));
  const stillUnresolved = new Set(playersToPrice);

  /** Prices everyone a bulk pull turns out to cover, and leaves the rest to the next phase. A
   * player the pull *did* cover is resolved either way: a stat line below the minutes threshold is
   * a real answer about him, and no further pull would say anything different. */
  async function applyBulkPullEntries(
    entries: readonly PlayerSeasonStatistics[],
    source: "leagueBulk" | "clubBulk",
  ): Promise<void> {
    const entriesByPlayerExternalId = new Map<string, PlayerSeasonStatistics[]>();
    for (const entry of entries) {
      const forPlayer = entriesByPlayerExternalId.get(entry.externalId) ?? [];
      forPlayer.push(entry);
      entriesByPlayerExternalId.set(entry.externalId, forPlayer);
    }

    for (const [externalId, playerEntries] of entriesByPlayerExternalId) {
      const player = playersByExternalId.get(externalId);
      if (!player || !stillUnresolved.has(player)) continue;
      const statLine = selectPrimaryDomesticLeagueEntry(playerEntries, domesticLeagueIds);
      if (!statLine) continue;
      await applyPriceFromStatLine(player, statLine, source);
      resolvedByBulkPull.add(externalId);
      stillUnresolved.delete(player);
    }
  }

  for (const leagueBulkPull of plan.leagueBulkPulls) {
    if (leagueBulkPull.leagueId !== PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID) {
      // fetchAllPlayerSeasonStatistics is the only league-wide pull the provider exposes and it is
      // scoped to the Premier League, so no other league should ever reach here.
      console.warn(`Skipping planned bulk pull for league ${leagueBulkPull.leagueId} — no league-wide pull exists for it.`);
      continue;
    }
    console.log(`\nLeague bulk: Premier League season ${previousSeasonYear} (~${leagueBulkPull.callCost} calls).`);
    const entries = await provider.fetchAllPlayerSeasonStatistics(previousSeasonYear);
    bulkPulledLeagueIds.add(leagueBulkPull.leagueId);
    summary.leaguesBulkPulled++;
    await applyBulkPullEntries(entries, "leagueBulk");
    await delay(requestDelayMs);
  }

  for (const clubBulkPull of plan.clubBulkPulls) {
    const teamExternalId = teamExternalIdByCurrentClubName.get(clubBulkPull.clubName);
    if (!teamExternalId) {
      // Club name didn't match the provider's list for this season — its players fall through to
      // the individual lookups below.
      console.warn(
        `Club bulk skipped: "${clubBulkPull.clubName}" is not in the provider's season-${currentSeasonYear} club list.`,
      );
      continue;
    }
    console.log(
      `Club bulk: ${clubBulkPull.clubName} — ${clubBulkPull.playerExternalIds.length} unpriced players, ` +
        `pulling season ${previousSeasonYear}.`,
    );
    const entries = await provider.fetchTeamPlayerSeasonStatistics(teamExternalId, previousSeasonYear);
    bulkPulledClubNames.add(clubBulkPull.clubName);
    summary.clubsBulkPulled++;
    await applyBulkPullEntries(entries, "clubBulk");
    await delay(requestDelayMs);
  }

  console.log(`\nIndividual lookups for the ${stillUnresolved.size} players no bulk pull resolved.`);
  for (const player of stillUnresolved) {
    const externalId = player.externalId!;

    const quota = await provider.fetchQuotaStatus();
    if (quota.requestsLimitPerDay - quota.requestsUsedToday <= DAILY_QUOTA_RESERVE) {
      console.warn("Stopping early — daily quota nearly exhausted. Re-run later to resume from checkpoint.");
      summary.stoppedEarlyOnQuota = true;
      break;
    }

    const entries = await provider.fetchPlayerSeasonStatisticsAcrossCompetitions(externalId, previousSeasonYear);
    summary.individualLookupsSpent++;
    const statLine = selectPrimaryDomesticLeagueEntry(entries, domesticLeagueIds);
    if (statLine) {
      await applyPriceFromStatLine(player, statLine, "individual");
    } else {
      // Cup and international minutes only, or no data at all — the placeholder stands.
      summary.leftAtPlaceholderNoDomesticLeague++;
    }

    attemptedIndividualLookups.add(externalId);
    await persistCheckpoint({
      previousSeasonYear,
      attemptedIndividualLookupExternalIds: [...attemptedIndividualLookups],
      resolvedByBulkPullExternalIds: [...resolvedByBulkPull],
      bulkPulledClubNames: [...bulkPulledClubNames],
      bulkPulledLeagueIds: [...bulkPulledLeagueIds],
      sourceLeagueTally,
    });
    await delay(requestDelayMs);
  }

  // ---- Phase 5: report.
  await persistCheckpoint({
    previousSeasonYear,
    attemptedIndividualLookupExternalIds: [...attemptedIndividualLookups],
    resolvedByBulkPullExternalIds: [...resolvedByBulkPull],
    bulkPulledClubNames: [...bulkPulledClubNames],
    bulkPulledLeagueIds: [...bulkPulledLeagueIds],
    sourceLeagueTally,
  });

  const sourceLeagueDistribution = Object.fromEntries(
    Object.entries(pricedLeagueNameCounts).sort(([, a], [, b]) => b - a),
  );
  console.log(
    JSON.stringify({ summary, projectedCallCost: plan.projectedTotalCallCost, sourceLeagueDistribution }, null, 2),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
