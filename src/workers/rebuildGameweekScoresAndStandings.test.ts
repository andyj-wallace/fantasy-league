import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGameweek, buildLeague } from "../testing/fixtures";

/**
 * Unit tests for the shared rebuild primitive extracted from processMatchDataChanges — the piece
 * confirmationPasses and backfillMissingMatchStatsAndScores now also call directly. Its own
 * behavior (calculateTeamScores + per-league updateStandings + later-gameweek refresh) already had
 * coverage indirectly through processMatchDataChanges.test.ts; this file tests it in isolation so
 * that coverage doesn't depend on which caller happens to exercise it.
 */
const GAMEWEEK_ID = "gw-1";

const mocks = vi.hoisted(() => ({
  findGameweekById: vi.fn(),
  findAllLeagues: vi.fn(),
  findGameweekIdsWithStandingsAfter: vi.fn(),
  calculateTeamScores: vi.fn(),
  updateStandings: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  gameweeksRepository: { findById: mocks.findGameweekById },
  leaguesRepository: { findAll: mocks.findAllLeagues },
  leagueStandingsRepository: { findGameweekIdsWithStandingsAfter: mocks.findGameweekIdsWithStandingsAfter },
}));

vi.mock("./calculateTeamScores", () => ({ calculateTeamScores: mocks.calculateTeamScores }));
vi.mock("./updateStandings", () => ({ updateStandings: mocks.updateStandings }));

import { rebuildGameweekScoresAndStandings } from "./rebuildGameweekScoresAndStandings";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findGameweekById.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, number: 5 }));
  mocks.findAllLeagues.mockResolvedValue([buildLeague({ id: "league-1" })]);
  mocks.findGameweekIdsWithStandingsAfter.mockResolvedValue([]);
});

describe("rebuildGameweekScoresAndStandings", () => {
  it("rebuilds team scores once and standings once per league", async () => {
    mocks.findAllLeagues.mockResolvedValue([buildLeague({ id: "league-1" }), buildLeague({ id: "league-2" })]);

    await rebuildGameweekScoresAndStandings(GAMEWEEK_ID);

    expect(mocks.calculateTeamScores).toHaveBeenCalledTimes(1);
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.updateStandings.mock.calls).toEqual([
      ["league-1", GAMEWEEK_ID],
      ["league-2", GAMEWEEK_ID],
    ]);
  });

  it("also refreshes every later gameweek's standings for a league that already has one", async () => {
    mocks.findGameweekIdsWithStandingsAfter.mockResolvedValue(["gw-6", "gw-7"]);

    await rebuildGameweekScoresAndStandings(GAMEWEEK_ID);

    expect(mocks.findGameweekIdsWithStandingsAfter).toHaveBeenCalledWith("league-1", 5);
    expect(mocks.updateStandings.mock.calls).toEqual([
      ["league-1", GAMEWEEK_ID],
      ["league-1", "gw-6"],
      ["league-1", "gw-7"],
    ]);
  });

  it("keeps each league's later-gameweek refresh independent of the others'", async () => {
    mocks.findAllLeagues.mockResolvedValue([buildLeague({ id: "league-1" }), buildLeague({ id: "league-2" })]);
    mocks.findGameweekIdsWithStandingsAfter.mockImplementation(async (leagueId: string) =>
      leagueId === "league-1" ? ["gw-6"] : [],
    );

    await rebuildGameweekScoresAndStandings(GAMEWEEK_ID);

    expect(mocks.updateStandings.mock.calls).toEqual([
      ["league-1", GAMEWEEK_ID],
      ["league-1", "gw-6"],
      ["league-2", GAMEWEEK_ID],
    ]);
  });

  it("does nothing when the gameweek does not exist", async () => {
    mocks.findGameweekById.mockResolvedValue(null);

    await rebuildGameweekScoresAndStandings("missing-gameweek");

    expect(mocks.calculateTeamScores).not.toHaveBeenCalled();
    expect(mocks.findAllLeagues).not.toHaveBeenCalled();
    expect(mocks.updateStandings).not.toHaveBeenCalled();
  });
});
