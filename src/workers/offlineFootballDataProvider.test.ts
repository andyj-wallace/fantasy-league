import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRecordedFixtureFileName,
  OfflineFootballDataProvider,
  RECORDED_FIXTURES_DIRECTORY_PATH,
} from "./offlineFootballDataProvider";

/**
 * Strategy-2 regression tests (see docs/remaining-gaps-todo.md): replay the response envelopes
 * recorded from the real API by `npm run record:fixtures` through the real ApiFootballProvider
 * parsing paths, and pin what they produce. The manifest names the recorded fixture so nothing
 * here hardcodes a provider ID.
 */
interface RecordedFixturesManifest {
  seasonYear: number;
  recordedFixture: { externalId: string; finalHomeScore: number; finalAwayScore: number };
  counts: { seasonFixtures: number; fixturePlayerStats: number; injuries: number };
}

const manifest = JSON.parse(
  readFileSync(join(RECORDED_FIXTURES_DIRECTORY_PATH, "manifest.json"), "utf8"),
) as RecordedFixturesManifest;

function buildOfflineProvider(): OfflineFootballDataProvider {
  return new OfflineFootballDataProvider(manifest.seasonYear);
}

describe("buildRecordedFixtureFileName", () => {
  it("flattens the path and sorts params by key", () => {
    expect(buildRecordedFixtureFileName("fixtures/players", { fixture: "1208191" })).toBe(
      "fixtures_players__fixture=1208191.json",
    );
    expect(buildRecordedFixtureFileName("fixtures", { season: 2024, league: 39 })).toBe(
      "fixtures__league=39&season=2024.json",
    );
  });

  it("uses the bare path when there are no params", () => {
    expect(buildRecordedFixtureFileName("status", {})).toBe("status.json");
  });
});

describe("OfflineFootballDataProvider — recorded envelope replay", () => {
  it("replays the full recorded season fixture list with parseable rounds, kickoffs and statuses", async () => {
    const fixtures = await buildOfflineProvider().fetchSeasonFixtures();

    expect(fixtures).toHaveLength(manifest.counts.seasonFixtures);
    expect(fixtures).toHaveLength(380); // a full 38-round Premier League season
    for (const fixture of fixtures) {
      expect(fixture.externalId).toMatch(/^\d+$/);
      expect(fixture.roundLabel).toMatch(/\d+\s*$/);
      expect(fixture.kickoffAt).toBeInstanceOf(Date);
      expect(Number.isNaN(fixture.kickoffAt.getTime())).toBe(false);
      expect(fixture.homeClub).not.toBe("");
      expect(fixture.awayClub).not.toBe("");
      expect(fixture.statusShortCode).not.toBe("");
    }
  });

  it("replays the recorded fixture's player stats, merged from the players and events endpoints", async () => {
    const { playerStats: stats } = await buildOfflineProvider().fetchFixturePlayerStatsAndGoalEvents(manifest.recordedFixture.externalId);

    expect(stats).toHaveLength(manifest.counts.fixturePlayerStats);
    const goalsAcrossBothSquads = stats.reduce((sum, stat) => sum + stat.goalsScored + stat.ownGoalsScored, 0);
    expect(goalsAcrossBothSquads).toBe(manifest.recordedFixture.finalHomeScore + manifest.recordedFixture.finalAwayScore);
    for (const stat of stats) {
      expect(stat.externalPlayerId).toMatch(/^\d+$/);
      expect(stat.minutesPlayed).toBeGreaterThanOrEqual(0);
      expect(stat.minutesPlayed).toBeLessThanOrEqual(120);
    }
  });

  it("replays the recorded injury report", async () => {
    const injuries = await buildOfflineProvider().fetchInjuries();

    expect(injuries).toHaveLength(manifest.counts.injuries);
    for (const injury of injuries) {
      expect(injury.externalPlayerId).toMatch(/^\d+$/);
      expect(injury.type).not.toBe("");
    }
  });

  it("fails with a pointer to record:fixtures when a request was never recorded", async () => {
    await expect(buildOfflineProvider().fetchLeagueCurrentSeason()).rejects.toThrow(/npm run record:fixtures/);
  });
});
