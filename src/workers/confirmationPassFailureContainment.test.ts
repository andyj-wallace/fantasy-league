import { beforeEach, describe, expect, it, vi } from "vitest";
import { StubFootballDataProvider } from "./footballDataProvider";

/**
 * Pins the degrade-and-warn guard around runWorkerCycle's confirmation-pass stage.
 *
 * runDueConfirmationPasses sits between the discovery import and the two stages that finish the
 * cycle, and until 2026-08-26 nothing anywhere on that path had a try/catch. A throw from it
 * therefore cost far more than the pass it came from:
 *
 * - `runLiveMatchPollingTick` never ran, so `nextLivePollDueAt` was never advanced. Live polling
 *   stopped entirely, and the gate reopened on every cycle to repeat the same failure.
 * - `processMatchDataChanges` never ran, *permanently* discarding that cycle's discovery
 *   completions: `lastDiscoveryRanAt` had already been written, so the same fixtures are not
 *   newly-completed again on any later cycle and nothing re-derives them.
 *
 * runDueConfirmationPasses now contains its own per-pass failures, so this guard is defence in
 * depth against an unanticipated throw — but it is the layer that decides a broken confirmation
 * pass can never again take scoring offline, so it gets its own test.
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
// this file about the containment guard and nothing else.
vi.mock("./importPlayerRoster", () => ({ importPlayerRoster: mocks.importPlayerRoster }));
vi.mock("./importPlayerAvailability", () => ({ importPlayerAvailability: mocks.importPlayerAvailability }));
vi.mock("./importMatchData", () => ({ importMatchData: mocks.importMatchData }));
vi.mock("./confirmationPasses", () => ({ runDueConfirmationPasses: mocks.runDueConfirmationPasses }));
vi.mock("./liveMatchPolling", () => ({ runLiveMatchPollingTick: mocks.runLiveMatchPollingTick }));
vi.mock("./processMatchDataChanges", () => ({ processMatchDataChanges: mocks.processMatchDataChanges }));

const { runWorkerCycle } = await import("./runWorkerCycle");

const NO_IMPORT_CHANGES = { newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [] };
const DISCOVERED_COMPLETIONS = { newlyCompletedMatchIds: ["match-discovered"], newlyDisruptedMatchIds: [] };

/** Every gate fresh except discovery, so the cycle does exactly one import and then falls through
 * to the confirmation-pass stage under test. */
function buildPollStateWithDiscoveryDue(now: Date) {
  return {
    id: "poll-state-singleton",
    lastDiscoveryRanAt: null,
    lastRosterImportRanAt: now,
    lastAvailabilitySyncRanAt: now,
    nextLivePollDueAt: null,
    currentSeasonYear: 2026,
    coverageFixturePlayerStats: true,
    coverageInjuries: true,
    lastSeasonSyncRanAt: now,
  };
}

describe("runWorkerCycle confirmation-pass containment", () => {
  const now = new Date("2026-08-26T18:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getOrCreatePollState.mockResolvedValue(buildPollStateWithDiscoveryDue(now));
    mocks.importMatchData.mockResolvedValue(DISCOVERED_COMPLETIONS);
    mocks.runLiveMatchPollingTick.mockResolvedValue(NO_IMPORT_CHANGES);
  });

  it("still runs the live poll and processes this cycle's discovery completions when the confirmation-pass stage throws", async () => {
    mocks.runDueConfirmationPasses.mockRejectedValue(new Error("confirmation pass stage exploded"));

    await runWorkerCycle(new StubFootballDataProvider());

    expect(mocks.runLiveMatchPollingTick).toHaveBeenCalledTimes(1);
    expect(mocks.processMatchDataChanges).toHaveBeenCalledWith(DISCOVERED_COMPLETIONS);
  });

  it("warns about the failure rather than swallowing it silently", async () => {
    const stageFailure = new Error("confirmation pass stage exploded");
    mocks.runDueConfirmationPasses.mockRejectedValue(stageFailure);

    await runWorkerCycle(new StubFootballDataProvider());

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("confirmation"), stageFailure);
  });

  it("does not warn on the ordinary path where the confirmation-pass stage succeeds", async () => {
    mocks.runDueConfirmationPasses.mockResolvedValue(undefined);

    await runWorkerCycle(new StubFootballDataProvider());

    expect(console.warn).not.toHaveBeenCalled();
    expect(mocks.processMatchDataChanges).toHaveBeenCalledWith(DISCOVERED_COMPLETIONS);
  });
});
