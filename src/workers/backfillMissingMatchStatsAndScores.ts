import "dotenv/config";
import {
  gameweeksRepository,
  matchesRepository,
  matchGoalEventsRepository,
  playerMatchStatsRepository,
  providerPollStateRepository,
} from "../db/repositories";
import { calculatePlayerScores } from "./calculatePlayerScores";
import { createFootballDataProviderFromEnv } from "./createFootballDataProviderFromEnv";
import { resolveMatchGoalEvents, resolvePlayerMatchStats } from "./importMatchData";
import { rebuildGameweekScoresAndStandings } from "./rebuildGameweekScoresAndStandings";

/**
 * One-off recovery for matches that reached COMPLETED without their raw per-player stats ever
 * being imported (`npm run backfill:match-scores -- --gameweek 1 --execute`).
 *
 * Why this cannot be left to the worker: importMatchData fetches player stats *only* on the
 * transition into COMPLETED (`status === "COMPLETED" && previousStatus !== "COMPLETED"`). A match
 * that completed while something upstream suppressed the stats fetch is therefore never revisited
 * — no later tick will ever fill it in, and its PlayerScore rows stay absent forever.
 *
 * The 2026-08-24 incident that prompted this: provider_poll_state.coverage_fixture_player_stats
 * was synced to `false` 18 hours before the season's first kickoff, when API-Football still
 * reported statistics_players false for season 2026. That flag gates
 * fetchFixturePlayerStatsAndGoalEvents, and the season sync only re-runs every 30 days — so all
 * ten Gameweek 1 matches completed with zero PlayerMatchStat rows, every PlayerScore missing, and
 * every manager's TeamScore and LeagueStanding written as 0.
 *
 * What this deliberately does NOT do: mark the gameweek completed, or award gameweek free
 * transfers. Both already fired when the gameweek closed the first time (that cascade is why the
 * zero-point TeamScore rows exist at all), and awardGameweekFreeTransfers has no ledger of its own
 * — it increments every team's banked count by 2 unconditionally. What keeps it to once per round
 * is processMatchDataChanges awarding only when gameweeksRepository.markCompletedIfNotAlready
 * reports that its conditional UPDATE was the statement that closed the round; a repair script
 * running that cascade would find the round already closed and correctly award nothing. This script
 * still stays out of it, because closing rounds is not a repair script's job — and it no longer has
 * to: since 2026-08-26 the cascade's score rebuild is not gated on the gameweek being open, so an
 * automated late completion repairs a closed round's numbers on its own.
 *
 * Everything it does write is an idempotent rebuild — replaceForMatch on both raw tables, and the
 * same rebuildGameweekScoresAndStandings the worker runs after every completed match — so
 * re-running it is safe. Sharing that helper (rather than calling calculateTeamScores/
 * updateStandings directly, as this script used to) also fixed a latent gap here: this script used
 * to rebuild only the target gameweek's own standings row, silently leaving any later gameweek's
 * cumulative totalPoints stale if it were ever run against a gameweek that already had later
 * gameweeks scored. It now refreshes those too, the same way processMatchDataChanges always has.
 *
 * Dry run by default: it performs the provider reads and reports exactly what it would write,
 * touching nothing. Pass --execute to commit.
 */

interface BackfillArguments {
  gameweekNumber: number;
  shouldExecuteWrites: boolean;
}

function parseBackfillArguments(argv: string[]): BackfillArguments {
  const gameweekFlagIndex = argv.indexOf("--gameweek");
  const gameweekNumber = gameweekFlagIndex === -1 ? 1 : Number(argv[gameweekFlagIndex + 1]);
  if (!Number.isInteger(gameweekNumber) || gameweekNumber < 1) {
    throw new Error(`--gameweek must be a positive integer (got "${argv[gameweekFlagIndex + 1]}")`);
  }
  return { gameweekNumber, shouldExecuteWrites: argv.includes("--execute") };
}

async function backfillMissingMatchStatsAndScores(): Promise<void> {
  const { gameweekNumber, shouldExecuteWrites } = parseBackfillArguments(process.argv.slice(2));
  const mode = shouldExecuteWrites ? "EXECUTE (writes committed)" : "DRY RUN (nothing written)";
  console.log(`[backfill] gameweek ${gameweekNumber} — ${mode}`);

  const provider = createFootballDataProviderFromEnv();

  // Resolve coverage from the provider directly rather than trusting provider_poll_state: the
  // stale flag in that row is the whole reason the stats are missing, and it gates the fetch below.
  const seasonInfo = await provider.fetchLeagueCurrentSeason();
  if (!seasonInfo) throw new Error("Provider returned no current season — cannot resolve stats coverage.");
  console.log(
    `[backfill] provider season ${seasonInfo.seasonYear}: fixture_stats=${seasonInfo.coverageFixturePlayerStats}, injuries=${seasonInfo.coverageInjuries}`,
  );
  if (!seasonInfo.coverageFixturePlayerStats) {
    throw new Error(
      `Provider still reports statistics_players=false for season ${seasonInfo.seasonYear} — the stats do not exist upstream yet, so there is nothing to backfill.`,
    );
  }
  provider.setCurrentSeason(seasonInfo.seasonYear, {
    fixturePlayerStats: seasonInfo.coverageFixturePlayerStats,
    injuries: seasonInfo.coverageInjuries,
  });

  const gameweek = await gameweeksRepository.findByNumber(gameweekNumber);
  if (!gameweek) throw new Error(`No Gameweek ${gameweekNumber} exists.`);

  const matches = await matchesRepository.findByGameweekId(gameweek.id);
  const completedMatches = matches.filter((match) => match.status === "COMPLETED");

  const matchesMissingStats = [];
  for (const match of completedMatches) {
    const existingStats = await playerMatchStatsRepository.findByMatchId(match.id);
    if (existingStats.length === 0) matchesMissingStats.push(match);
  }

  console.log(
    `[backfill] gameweek ${gameweekNumber}: ${matches.length} matches, ${completedMatches.length} completed, ${matchesMissingStats.length} missing stats`,
  );
  if (matchesMissingStats.length === 0) {
    console.log("[backfill] nothing to do.");
    return;
  }

  for (const match of matchesMissingStats) {
    if (!match.externalId) {
      console.log(`[backfill] SKIP ${match.homeClub} v ${match.awayClub} — no externalId, provider cannot be queried`);
      continue;
    }

    const { playerStats, goalEvents } = await provider.fetchFixturePlayerStatsAndGoalEvents(match.externalId);
    const resolvedStats = await resolvePlayerMatchStats(match.id, playerStats);
    const resolvedGoalEvents = await resolveMatchGoalEvents(match.id, goalEvents);
    console.log(
      `[backfill] ${match.homeClub} v ${match.awayClub}: provider returned ${playerStats.length} player stats (${resolvedStats.length} matched to our players), ${goalEvents.length} goal events (${resolvedGoalEvents.length} resolved)`,
    );

    if (!shouldExecuteWrites) continue;

    await playerMatchStatsRepository.replaceForMatch(match.id, resolvedStats);
    await matchGoalEventsRepository.replaceForMatch(match.id, resolvedGoalEvents);
    await calculatePlayerScores(match.id);
  }

  if (!shouldExecuteWrites) {
    console.log("[backfill] DRY RUN complete — nothing written. Re-run with --execute to commit.");
    return;
  }

  // Same rebuild processMatchDataChanges runs after a completed match, and for the same reason:
  // PlayerScore rows just changed, so this gameweek's team totals and every league's table (plus
  // every later gameweek's cumulative table) are stale. Idempotent, so this corrects the
  // zero-point rows in place.
  await rebuildGameweekScoresAndStandings(gameweek.id);
  console.log(`[backfill] rebuilt team scores and every league's standings for gameweek ${gameweekNumber}`);

  // Correct the flag that caused this, and clear the sync stamp so the next worker tick re-reads
  // coverage rather than waiting out the remainder of the 30-day season-sync gate.
  const pollState = await providerPollStateRepository.getOrCreate();
  await providerPollStateRepository.update(pollState.id, {
    currentSeasonYear: seasonInfo.seasonYear,
    coverageFixturePlayerStats: seasonInfo.coverageFixturePlayerStats,
    coverageInjuries: seasonInfo.coverageInjuries,
    lastSeasonSyncRanAt: null,
  });
  console.log("[backfill] provider_poll_state coverage corrected; season sync will re-run on the next tick");
  console.log("[backfill] done. Gameweek completion and free-transfer awards were deliberately left untouched.");
}

backfillMissingMatchStatsAndScores().catch((error) => {
  console.error("[backfill] failed:", error);
  process.exit(1);
});
