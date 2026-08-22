import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlayer } from "../../../testing/fixtures";

/**
 * Unit tests for the read-side fold from PlayerScore rows into player-card stats. The repository is
 * mocked: we describe the scored rows the query would return, then assert on the three shapes the
 * UI consumes — the cumulative total, the recent-form slice, and the per-gameweek map behind the
 * squad builder's gameweek summary.
 */
const mocks = vi.hoisted(() => ({
  findManyByPlayerIds: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  playerScoresRepository: { findManyByPlayerIds: mocks.findManyByPlayerIds },
}));

import { attachPlayerStats } from "./attachPlayerStats";

/** One row as findManyByPlayerIds returns it — newest gameweek first, no breakdown jsonb. */
function scoreRow(playerId: string, gameweekNumber: number, totalPoints: number, didAppear = true) {
  return { playerId, gameweekNumber, totalPoints, didAppear };
}

describe("attachPlayerStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keys each gameweek's points by its gameweek number", async () => {
    const player = buildPlayer({ id: "p1" });
    mocks.findManyByPlayerIds.mockResolvedValue([
      scoreRow("p1", 14, 9),
      scoreRow("p1", 13, 2),
      scoreRow("p1", 12, 6),
    ]);

    const [withStats] = await attachPlayerStats([player]);

    expect(withStats!.pointsByGameweekNumber).toEqual({
      14: { totalPoints: 9, didAppear: true },
      13: { totalPoints: 2, didAppear: true },
      12: { totalPoints: 6, didAppear: true },
    });
    expect(withStats!.totalFantasyPoints).toBe(17);
    expect(withStats!.recentFormPoints).toEqual([9, 2, 6]);
  });

  it("sums two matches sharing one gameweek rather than letting the later row win", async () => {
    // A postponed fixture replayed under its original round label lands a second row in the same
    // gameweek. Overwriting would silently discard one match's points.
    const player = buildPlayer({ id: "p1" });
    mocks.findManyByPlayerIds.mockResolvedValue([scoreRow("p1", 14, 6), scoreRow("p1", 14, 3)]);

    const [withStats] = await attachPlayerStats([player]);

    expect(withStats!.pointsByGameweekNumber[14]).toEqual({ totalPoints: 9, didAppear: true });
    expect(withStats!.totalFantasyPoints).toBe(9);
  });

  it("treats a player as having appeared if they played in either of a gameweek's matches", async () => {
    const player = buildPlayer({ id: "p1" });
    mocks.findManyByPlayerIds.mockResolvedValue([
      scoreRow("p1", 14, 0, false),
      scoreRow("p1", 14, 4, true),
    ]);

    const [withStats] = await attachPlayerStats([player]);

    expect(withStats!.pointsByGameweekNumber[14]).toEqual({ totalPoints: 4, didAppear: true });
  });

  it("keeps a scored-but-did-not-appear gameweek distinct from an unscored one", async () => {
    // An unused substitute has a row worth 0 and didAppear false. That is not the same as having
    // no row at all: the first is ineligible for the captain bonus, the second hasn't played yet.
    const player = buildPlayer({ id: "p1" });
    mocks.findManyByPlayerIds.mockResolvedValue([scoreRow("p1", 14, 0, false)]);

    const [withStats] = await attachPlayerStats([player]);

    expect(withStats!.pointsByGameweekNumber[14]).toEqual({ totalPoints: 0, didAppear: false });
    expect(withStats!.pointsByGameweekNumber[13]).toBeUndefined();
  });

  it("gives a player with no scored matches an empty map rather than a missing field", async () => {
    const player = buildPlayer({ id: "p1" });
    mocks.findManyByPlayerIds.mockResolvedValue([]);

    const [withStats] = await attachPlayerStats([player]);

    expect(withStats!.pointsByGameweekNumber).toEqual({});
    expect(withStats!.totalFantasyPoints).toBe(0);
    expect(withStats!.recentFormPoints).toBeNull();
  });

  it("does not leak one player's gameweek points into another's", async () => {
    const first = buildPlayer({ id: "p1" });
    const second = buildPlayer({ id: "p2" });
    mocks.findManyByPlayerIds.mockResolvedValue([scoreRow("p1", 14, 9), scoreRow("p2", 14, 1)]);

    const [firstWithStats, secondWithStats] = await attachPlayerStats([first, second]);

    expect(firstWithStats!.pointsByGameweekNumber[14]?.totalPoints).toBe(9);
    expect(secondWithStats!.pointsByGameweekNumber[14]?.totalPoints).toBe(1);
  });
});
