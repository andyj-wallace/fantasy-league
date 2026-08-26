import { describe, expect, it } from "vitest";
import {
  MATCH_POLLING_ABANDONMENT_WINDOW_MS,
  MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION,
  partitionMatchesByPollingAbandonmentWindow,
  resolveEarliestKickoffStillWorthPolling,
  summarizeGameweekMatchProgress,
} from "./match";
import type { MatchStatus } from "./shared";

/** Progress is read off status alone, so the tests describe fixtures by status only. */
function matchesWithStatuses(...statuses: MatchStatus[]): { status: MatchStatus }[] {
  return statuses.map((status) => ({ status }));
}

describe("summarizeGameweekMatchProgress", () => {
  it("counts completed matches as played and reports the gameweek unfinished", () => {
    const progress = summarizeGameweekMatchProgress(
      matchesWithStatuses("COMPLETED", "COMPLETED", "IN_PROGRESS", "SCHEDULED"),
    );

    expect(progress).toEqual({ finalizedMatchCount: 2, totalMatchCount: 4, isGameweekReadyToClose: false });
  });

  it("treats a voided match as final so it cannot hold the gameweek open forever", () => {
    // Mirrors gameweeksRepository.hasEveryMatchStoppedBlockingGameweekCompletion, which gates
    // gameweek closure, the free-transfer award, TeamScores and standings.
    const progress = summarizeGameweekMatchProgress(matchesWithStatuses("COMPLETED", "VOIDED"));

    expect(progress.isGameweekReadyToClose).toBe(true);
    expect(progress.finalizedMatchCount).toBe(2);
  });

  it("lets a round finish with a postponed fixture outstanding, without counting it as played", () => {
    // The two halves are deliberately different questions. The round is finished — the worker will
    // close it and pay its free transfers — but only one of the two fixtures has actually been
    // played, and progress copy that said "2 of 2 played" would be untrue. The postponed one is
    // replayed later and scored back into this same gameweek.
    const progress = summarizeGameweekMatchProgress(matchesWithStatuses("COMPLETED", "POSTPONED"));

    expect(progress.isGameweekReadyToClose).toBe(true);
    expect(progress.finalizedMatchCount).toBe(1);
    expect(progress.totalMatchCount).toBe(2);
  });

  it.each(MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION)(
    "keeps the gameweek open while a fixture is %s",
    (blockingStatus) => {
      const progress = summarizeGameweekMatchProgress(matchesWithStatuses("COMPLETED", blockingStatus));

      expect(progress.isGameweekReadyToClose).toBe(false);
    },
  );

  it("reports an empty fixture list as not ready to close rather than trivially complete", () => {
    // A gameweek with no imported fixtures hasn't finished; it hasn't started.
    expect(summarizeGameweekMatchProgress([])).toEqual({
      finalizedMatchCount: 0,
      totalMatchCount: 0,
      isGameweekReadyToClose: false,
    });
  });
});

/**
 * The live poller's abandonment window, tested as the pure rule it is. The rule has exactly one
 * enforcement point — liveMatchPolling, which partitions what findPotentiallyLive returned before
 * the length check that arms the tick. The repository deliberately does not filter by it, so that an
 * abandoned fixture can still be logged rather than vanishing silently; see the constant's own doc
 * comment. That single enforcement point is what these tests cover.
 */
const NOW = new Date("2026-08-21T20:56:00Z");
const HOUR_MS = 60 * 60 * 1000;

function kickoffHoursBeforeNow(hours: number): { kickoffAt: Date } {
  return { kickoffAt: new Date(NOW.getTime() - hours * HOUR_MS) };
}

describe("MATCH_POLLING_ABANDONMENT_WINDOW_MS", () => {
  it("is 24 hours", () => {
    expect(MATCH_POLLING_ABANDONMENT_WINDOW_MS).toBe(24 * HOUR_MS);
  });

  it("outlasts the worker's 12-hour discovery gate, so discovery gets a shot before the poller lets go", () => {
    // DISCOVERY_GATE_MS in runWorkerCycle.ts. fetchSeasonFixtures is the only pass that carries
    // terminal statuses, so it is what heals a stuck row — a window shorter than its gate would
    // hand rows to a pass that has not run yet. Restated here as a number rather than imported:
    // the worker constant is module-private, and the point is that this window must exceed it.
    const DISCOVERY_GATE_MS = 12 * HOUR_MS;
    expect(MATCH_POLLING_ABANDONMENT_WINDOW_MS).toBeGreaterThan(DISCOVERY_GATE_MS);
  });
});

describe("resolveEarliestKickoffStillWorthPolling", () => {
  it("is exactly one window back from now — the bound findPotentiallyLive filters on", () => {
    expect(resolveEarliestKickoffStillWorthPolling(NOW)).toEqual(
      new Date(NOW.getTime() - MATCH_POLLING_ABANDONMENT_WINDOW_MS),
    );
  });
});

describe("partitionMatchesByPollingAbandonmentWindow", () => {
  it("keeps a match still inside the window and abandons one outside it", () => {
    const justInside = kickoffHoursBeforeNow(23);
    const justOutside = kickoffHoursBeforeNow(25);

    const partition = partitionMatchesByPollingAbandonmentWindow([justInside, justOutside], NOW);

    expect(partition.stillWithinPollingWindow).toEqual([justInside]);
    expect(partition.abandonedLongAfterKickoff).toEqual([justOutside]);
  });

  it("counts a kickoff exactly one window old as still worth polling — the boundary is inclusive", () => {
    const exactlyOnTheBound = { kickoffAt: resolveEarliestKickoffStillWorthPolling(NOW) };

    const partition = partitionMatchesByPollingAbandonmentWindow([exactlyOnTheBound], NOW);

    expect(partition.stillWithinPollingWindow).toEqual([exactlyOnTheBound]);
    expect(partition.abandonedLongAfterKickoff).toEqual([]);
  });

  it("keeps a match whose kickoff is still in the future", () => {
    // findPotentiallyLive's under-way arm has no upper kickoff bound, so a row the provider has
    // reported in play ahead of our stored kickoff time must not be mistaken for an abandoned one.
    const kickoffAhead = { kickoffAt: new Date(NOW.getTime() + HOUR_MS) };

    const partition = partitionMatchesByPollingAbandonmentWindow([kickoffAhead], NOW);

    expect(partition.stillWithinPollingWindow).toEqual([kickoffAhead]);
    expect(partition.abandonedLongAfterKickoff).toEqual([]);
  });

  it("preserves input order within each side of the partition", () => {
    const first = kickoffHoursBeforeNow(1);
    const second = kickoffHoursBeforeNow(100);
    const third = kickoffHoursBeforeNow(2);
    const fourth = kickoffHoursBeforeNow(200);

    const partition = partitionMatchesByPollingAbandonmentWindow([first, second, third, fourth], NOW);

    expect(partition.stillWithinPollingWindow).toEqual([first, third]);
    expect(partition.abandonedLongAfterKickoff).toEqual([second, fourth]);
  });

  it("returns two empty sides for an empty list rather than throwing", () => {
    expect(partitionMatchesByPollingAbandonmentWindow([], NOW)).toEqual({
      stillWithinPollingWindow: [],
      abandonedLongAfterKickoff: [],
    });
  });
});
