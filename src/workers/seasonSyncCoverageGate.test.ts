import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSeasonInfo } from "./footballDataProvider";
import { StubFootballDataProvider } from "./footballDataProvider";

/**
 * Pins the asymmetric season-sync gate in runWorkerCycle.
 *
 * The 2026-08-24 incident this encodes: the season year and the coverage flags arrive on the same
 * /leagues call, but they change on wildly different schedules. The year changes once a season, so
 * a 30-day gate is right for it. Coverage flips false→true the moment the provider starts
 * populating a new season — and a sync landing in the hours before that flip pinned us to `false`
 * for the rest of the month. Because coverageFixturePlayerStats gates the fixture-stats fetch, and
 * importMatchData only fetches a match's stats on its transition into COMPLETED, every match that
 * completed inside that window lost its stats permanently and scored zero for everyone: all ten of
 * Gameweek 1's, in production.
 *
 * So the gate has to be short while coverage is incomplete and long once it isn't. Both halves are
 * asserted here — a fast re-check that never arrives is the bug, and a permanent 1-hour poll of
 * /leagues would be a quieter one.
 */
const mocks = vi.hoisted(() => ({
  getOrCreatePollState: vi.fn(),
  updatePollState: vi.fn(),
  importPlayerRoster: vi.fn(),
  importPlayerAvailability: vi.fn(),
  importMatchData: vi.fn(),
  runDueConfirmationPasses: vi.fn(),
  runLiveMatchPollingTick: vi.fn(),
  processMatchDataChanges: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  providerPollStateRepository: {
    getOrCreate: mocks.getOrCreatePollState,
    update: mocks.updatePollState,
  },
}));

// Every downstream stage is some other test's subject; mocking them at the module boundary keeps
// this file about the gate and nothing else.
vi.mock("./importPlayerRoster", () => ({ importPlayerRoster: mocks.importPlayerRoster }));
vi.mock("./importPlayerAvailability", () => ({ importPlayerAvailability: mocks.importPlayerAvailability }));
vi.mock("./importMatchData", () => ({ importMatchData: mocks.importMatchData }));
vi.mock("./confirmationPasses", () => ({ runDueConfirmationPasses: mocks.runDueConfirmationPasses }));
vi.mock("./liveMatchPolling", () => ({ runLiveMatchPollingTick: mocks.runLiveMatchPollingTick }));
vi.mock("./processMatchDataChanges", () => ({ processMatchDataChanges: mocks.processMatchDataChanges }));

const { runWorkerCycle } = await import("./runWorkerCycle");

const NO_IMPORT_CHANGES = { newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [] };
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/** Reports full coverage, so a sync that runs is observable by the flags it writes back. */
class SeasonInfoProvider extends StubFootballDataProvider {
  override async fetchLeagueCurrentSeason(): Promise<ProviderSeasonInfo | null> {
    return {
      seasonYear: 2026,
      coverageFixturePlayerStats: true,
      coveragePlayers: true,
      coverageInjuries: true,
    };
  }
}

/**
 * A poll state with every *other* gate deliberately fresh, so the only thing that can move in a
 * cycle is the season sync under test.
 */
function buildPollState(overrides: {
  lastSeasonSyncRanAt: Date;
  coverageFixturePlayerStats: boolean;
  coverageInjuries: boolean;
  now: Date;
}) {
  return {
    id: "poll-state-singleton",
    lastDiscoveryRanAt: overrides.now,
    lastRosterImportRanAt: overrides.now,
    lastAvailabilitySyncRanAt: overrides.now,
    nextLivePollDueAt: null,
    currentSeasonYear: 2026,
    coverageFixturePlayerStats: overrides.coverageFixturePlayerStats,
    coverageInjuries: overrides.coverageInjuries,
    lastSeasonSyncRanAt: overrides.lastSeasonSyncRanAt,
  };
}

function seasonSyncRan(): boolean {
  return mocks.updatePollState.mock.calls.some(([, changes]) => "lastSeasonSyncRanAt" in changes);
}

describe("runWorkerCycle season-sync gate", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.runLiveMatchPollingTick.mockResolvedValue(NO_IMPORT_CHANGES);
    mocks.importMatchData.mockResolvedValue(NO_IMPORT_CHANGES);
  });

  it("re-checks within the hour while fixture-stats coverage is still false", async () => {
    mocks.getOrCreatePollState.mockResolvedValue(
      buildPollState({
        lastSeasonSyncRanAt: new Date(now.getTime() - 2 * ONE_HOUR_MS),
        coverageFixturePlayerStats: false,
        coverageInjuries: true,
        now,
      }),
    );

    await runWorkerCycle(new SeasonInfoProvider());

    expect(seasonSyncRan()).toBe(true);
    expect(mocks.updatePollState).toHaveBeenCalledWith(
      "poll-state-singleton",
      expect.objectContaining({ coverageFixturePlayerStats: true }),
    );
  });

  it("re-checks within the hour while injuries coverage is still false", async () => {
    mocks.getOrCreatePollState.mockResolvedValue(
      buildPollState({
        lastSeasonSyncRanAt: new Date(now.getTime() - 2 * ONE_HOUR_MS),
        coverageFixturePlayerStats: true,
        coverageInjuries: false,
        now,
      }),
    );

    await runWorkerCycle(new SeasonInfoProvider());

    expect(seasonSyncRan()).toBe(true);
  });

  it("does not re-check more often than hourly, even with coverage incomplete", async () => {
    mocks.getOrCreatePollState.mockResolvedValue(
      buildPollState({
        lastSeasonSyncRanAt: new Date(now.getTime() - 30 * 60 * 1000),
        coverageFixturePlayerStats: false,
        coverageInjuries: false,
        now,
      }),
    );

    await runWorkerCycle(new SeasonInfoProvider());

    expect(seasonSyncRan()).toBe(false);
  });

  it("falls back to the monthly gate once the provider has confirmed full coverage", async () => {
    mocks.getOrCreatePollState.mockResolvedValue(
      buildPollState({
        lastSeasonSyncRanAt: new Date(now.getTime() - 2 * ONE_DAY_MS),
        coverageFixturePlayerStats: true,
        coverageInjuries: true,
        now,
      }),
    );

    await runWorkerCycle(new SeasonInfoProvider());

    expect(seasonSyncRan()).toBe(false);
  });

  it("still re-syncs monthly once coverage is confirmed, so a season rollover is picked up", async () => {
    mocks.getOrCreatePollState.mockResolvedValue(
      buildPollState({
        lastSeasonSyncRanAt: new Date(now.getTime() - 31 * ONE_DAY_MS),
        coverageFixturePlayerStats: true,
        coverageInjuries: true,
        now,
      }),
    );

    await runWorkerCycle(new SeasonInfoProvider());

    expect(seasonSyncRan()).toBe(true);
  });
});
