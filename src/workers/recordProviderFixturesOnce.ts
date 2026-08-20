import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApiFootballEnvelope } from "./apiFootballProvider";
import { ApiFootballProvider } from "./apiFootballProvider";
import type { ProviderFixture } from "./footballDataProvider";
import { buildRecordedFixtureFileName, RECORDED_FIXTURES_DIRECTORY_PATH } from "./offlineFootballDataProvider";

/**
 * One-time, manually-triggered Strategy-2 recorder (`npm run record:fixtures` — see
 * docs/remaining-gaps-todo.md): spends ~4 real API-Football calls capturing raw response
 * envelopes into src/workers/__fixtures__/, where OfflineFootballDataProvider replays them
 * forever after with zero quota. Records the season fixture list, then one completed fixture's
 * /fixtures/players + /fixtures/events, then /injuries — plus a manifest.json naming the chosen
 * fixture so the regression tests don't hardcode a provider ID.
 *
 * RECORD_FIXTURE_EXTERNAL_ID overrides the fixture choice (e.g. to re-record a specific match
 * known to contain an own goal); the default picks the completed fixture with the most total
 * goals, which maximizes the number of scoring code paths the recorded stats exercise.
 */
class RecordingApiFootballProvider extends ApiFootballProvider {
  protected override async request<T>(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<ApiFootballEnvelope<T>> {
    const envelope = await super.request<T>(path, params);
    const fileName = buildRecordedFixtureFileName(path, params);
    await writeFile(join(RECORDED_FIXTURES_DIRECTORY_PATH, fileName), JSON.stringify(envelope, null, 2));
    console.log(`recorded ${fileName}`);
    return envelope;
  }
}

function chooseFixtureToRecord(fixtures: ProviderFixture[]): ProviderFixture {
  const overrideExternalId = process.env.RECORD_FIXTURE_EXTERNAL_ID;
  if (overrideExternalId) {
    const overridden = fixtures.find((fixture) => fixture.externalId === overrideExternalId);
    if (!overridden) throw new Error(`RECORD_FIXTURE_EXTERNAL_ID=${overrideExternalId} is not in the season fixture list`);
    return overridden;
  }

  const completedFixtures = fixtures.filter((fixture) => fixture.statusShortCode === "FT");
  if (completedFixtures.length === 0) throw new Error("No completed (FT) fixtures in the season fixture list to record");
  return completedFixtures.reduce((highestScoring, fixture) =>
    (fixture.finalHomeScore ?? 0) + (fixture.finalAwayScore ?? 0) >
    (highestScoring.finalHomeScore ?? 0) + (highestScoring.finalAwayScore ?? 0)
      ? fixture
      : highestScoring,
  );
}

async function main(): Promise<void> {
  const baseUrl = process.env.FOOTBALL_DATA_API_BASE_URL ?? "https://v3.football.api-sports.io";
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) throw new Error("FOOTBALL_DATA_API_KEY is not set");
  const seasonYear = Number(process.env.FOOTBALL_DATA_SEASON_YEAR ?? 2024);

  await mkdir(RECORDED_FIXTURES_DIRECTORY_PATH, { recursive: true });

  const provider = new RecordingApiFootballProvider(baseUrl, apiKey, seasonYear);
  provider.setCurrentSeason(seasonYear, { fixturePlayerStats: true, injuries: true });

  const seasonFixtures = await provider.fetchSeasonFixtures();
  const fixtureToRecord = chooseFixtureToRecord(seasonFixtures);
  console.log(
    `recording fixture ${fixtureToRecord.externalId}: ${fixtureToRecord.homeClub} ` +
      `${fixtureToRecord.finalHomeScore}-${fixtureToRecord.finalAwayScore} ${fixtureToRecord.awayClub}`,
  );

  const { playerStats } = await provider.fetchFixturePlayerStatsAndGoalEvents(fixtureToRecord.externalId);
  const injuries = await provider.fetchInjuries();

  await writeFile(
    join(RECORDED_FIXTURES_DIRECTORY_PATH, "manifest.json"),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        seasonYear,
        recordedFixture: {
          externalId: fixtureToRecord.externalId,
          homeClub: fixtureToRecord.homeClub,
          awayClub: fixtureToRecord.awayClub,
          finalHomeScore: fixtureToRecord.finalHomeScore,
          finalAwayScore: fixtureToRecord.finalAwayScore,
          roundLabel: fixtureToRecord.roundLabel,
        },
        counts: { seasonFixtures: seasonFixtures.length, fixturePlayerStats: playerStats.length, injuries: injuries.length },
      },
      null,
      2,
    ),
  );
  console.log(`recorded manifest.json (${playerStats.length} player stat lines, ${injuries.length} injury entries)`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
