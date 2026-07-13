import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Match, PlayerMatchStat } from "../domain";
import { buildGameweek, buildMatch, buildPlayer } from "../testing/fixtures";

/**
 * Import-layer regression tests (Strategy 2, docs/remaining-gaps-todo.md): drive importMatchData
 * with the OfflineFootballDataProvider's recorded real-API envelopes and pin what reaches the
 * repositories — gameweek bootstrap from round labels, status mapping, externalId-keyed Match
 * upserts, and the players+events stat merge on a completion transition.
 */
const mocks = vi.hoisted(() => ({
  upsertGameweekByNumber: vi.fn(),
  findMatchByExternalId: vi.fn(),
  upsertMatch: vi.fn(),
  findPlayerByExternalId: vi.fn(),
  insertManyPlayerMatchStats: vi.fn(),
  scheduleConfirmationPass: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  gameweeksRepository: { upsertByNumber: mocks.upsertGameweekByNumber },
  matchesRepository: { findByExternalId: mocks.findMatchByExternalId, upsert: mocks.upsertMatch },
  playersRepository: { findByExternalId: mocks.findPlayerByExternalId },
  playerMatchStatsRepository: { insertMany: mocks.insertManyPlayerMatchStats },
  pendingConfirmationPassesRepository: { schedule: mocks.scheduleConfirmationPass },
}));

import { importMatchData } from "./importMatchData";
import { OfflineFootballDataProvider, RECORDED_FIXTURES_DIRECTORY_PATH } from "./offlineFootballDataProvider";

interface RecordedFixturesManifest {
  seasonYear: number;
  recordedFixture: { externalId: string; finalHomeScore: number; finalAwayScore: number };
  counts: { fixturePlayerStats: number };
}

const manifest = JSON.parse(
  readFileSync(join(RECORDED_FIXTURES_DIRECTORY_PATH, "manifest.json"), "utf8"),
) as RecordedFixturesManifest;

const GAMEWEEK_DEADLINE_BUFFER_MS = 90 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsertGameweekByNumber.mockImplementation(async (gameweekNumber: number) =>
    buildGameweek({ id: `gw-${gameweekNumber}`, number: gameweekNumber }),
  );
  mocks.findMatchByExternalId.mockResolvedValue(null);
  mocks.findPlayerByExternalId.mockImplementation(async (externalPlayerId: string) =>
    buildPlayer({ id: `internal-${externalPlayerId}`, externalId: externalPlayerId }),
  );
});

describe("importMatchData — recorded season discovery import", () => {
  it("bootstraps all 38 gameweeks and upserts every fixture as a completed, externalId-keyed Match", async () => {
    const provider = new OfflineFootballDataProvider(manifest.seasonYear);
    const fixtures = await provider.fetchSeasonFixtures();

    const result = await importMatchData(provider, fixtures);

    const bootstrappedGameweekNumbers = new Set(mocks.upsertGameweekByNumber.mock.calls.map(([number]) => number));
    expect(bootstrappedGameweekNumbers.size).toBe(38);
    expect(Math.min(...bootstrappedGameweekNumbers)).toBe(1);
    expect(Math.max(...bootstrappedGameweekNumbers)).toBe(38);

    expect(mocks.upsertMatch).toHaveBeenCalledTimes(380);
    for (const [match] of mocks.upsertMatch.mock.calls as [Match][]) {
      expect(match.externalId).toMatch(/^\d+$/);
      expect(match.status).toBe("COMPLETED"); // a finished season is FT across the board
      expect(match.gameweekId).toMatch(/^gw-\d+$/);
    }

    // The gameweek deadline derives from kickoff minus the lock buffer.
    const [, firstDeadline] = mocks.upsertGameweekByNumber.mock.calls[0]! as [number, Date];
    const firstFixture = fixtures[0]!;
    expect(firstDeadline.getTime()).toBe(firstFixture.kickoffAt.getTime() - GAMEWEEK_DEADLINE_BUFFER_MS);

    // First-time discovery of already-completed matches must not fire the scoring pipeline.
    expect(result.newlyCompletedMatchIds).toEqual([]);
    expect(result.newlyDisruptedMatchIds).toEqual([]);
    expect(mocks.insertManyPlayerMatchStats).not.toHaveBeenCalled();
    expect(mocks.scheduleConfirmationPass).not.toHaveBeenCalled();
  });
});

describe("importMatchData — completion transition on the recorded fixture", () => {
  it("imports the merged player stats and schedules a confirmation pass when a match reaches COMPLETED", async () => {
    const provider = new OfflineFootballDataProvider(manifest.seasonYear);
    const recordedFixture = (await provider.fetchSeasonFixtures()).find(
      (fixture) => fixture.externalId === manifest.recordedFixture.externalId,
    )!;
    expect(recordedFixture).toBeDefined();

    const existingInProgressMatch = buildMatch({
      id: "match-existing",
      externalId: recordedFixture.externalId,
      status: "IN_PROGRESS",
    });
    mocks.findMatchByExternalId.mockResolvedValue(existingInProgressMatch);

    const result = await importMatchData(provider, [recordedFixture]);

    expect(result.newlyCompletedMatchIds).toEqual(["match-existing"]);
    expect(mocks.insertManyPlayerMatchStats).toHaveBeenCalledTimes(1);
    const [stats] = mocks.insertManyPlayerMatchStats.mock.calls[0]! as [PlayerMatchStat[]];
    expect(stats).toHaveLength(manifest.counts.fixturePlayerStats);
    const goalsAcrossBothSquads = stats.reduce((sum, stat) => sum + stat.goalsScored + stat.ownGoalsScored, 0);
    expect(goalsAcrossBothSquads).toBe(manifest.recordedFixture.finalHomeScore + manifest.recordedFixture.finalAwayScore);
    for (const stat of stats) {
      expect(stat.matchId).toBe("match-existing");
      expect(stat.playerId).toMatch(/^internal-\d+$/);
    }

    expect(mocks.scheduleConfirmationPass).toHaveBeenCalledWith(
      "match-existing",
      recordedFixture.externalId,
      expect.any(Date),
    );
  });

  it("skips provider stat lines for players not yet imported instead of failing the match import", async () => {
    const provider = new OfflineFootballDataProvider(manifest.seasonYear);
    const recordedFixture = (await provider.fetchSeasonFixtures()).find(
      (fixture) => fixture.externalId === manifest.recordedFixture.externalId,
    )!;
    mocks.findMatchByExternalId.mockResolvedValue(
      buildMatch({ id: "match-existing", externalId: recordedFixture.externalId, status: "IN_PROGRESS" }),
    );
    mocks.findPlayerByExternalId.mockResolvedValue(null);

    const result = await importMatchData(provider, [recordedFixture]);

    expect(result.newlyCompletedMatchIds).toEqual(["match-existing"]);
    const [stats] = mocks.insertManyPlayerMatchStats.mock.calls[0]! as [PlayerMatchStat[]];
    expect(stats).toEqual([]);
  });
});
