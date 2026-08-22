import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGameweek, buildLeague, buildMatch, buildTeam } from "../testing/fixtures";

/**
 * Blast-radius tests for the completion cascade, written alongside live-poll reconciliation
 * (docs/stuck-live-match-reconciliation-plan.md).
 *
 * awardGameweekFreeTransfers is deliberately not idempotent — it increments every team's banked
 * transfers by 2 with no record of having done so — so the cascade behind it has to fire exactly
 * once per gameweek. Reconciliation opens a second route into newlyCompletedMatchIds, which makes
 * "an already-completed gameweek must not re-award" a correctness test rather than a tidiness one.
 * awardGameweekFreeTransfers therefore runs for real here, against a mocked teams repository, so
 * the assertion is about transfers actually granted.
 */
const mocks = vi.hoisted(() => ({
  findGameweekById: vi.fn(),
  areAllMatchesCompleted: vi.fn(),
  markGameweekCompleted: vi.fn(),
  findMatchById: vi.fn(),
  findAllLeagues: vi.fn(),
  findAllTeams: vi.fn(),
  incrementBankedFreeTransferCount: vi.fn(),
  calculatePlayerScores: vi.fn(),
  calculateTeamScores: vi.fn(),
  updateStandings: vi.fn(),
  awardPostponedMatchTransfers: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  gameweeksRepository: {
    findById: mocks.findGameweekById,
    areAllMatchesCompleted: mocks.areAllMatchesCompleted,
    markCompleted: mocks.markGameweekCompleted,
  },
  matchesRepository: { findById: mocks.findMatchById },
  leaguesRepository: { findAll: mocks.findAllLeagues },
  teamsRepository: { findAll: mocks.findAllTeams, incrementBankedFreeTransferCount: mocks.incrementBankedFreeTransferCount },
}));

vi.mock("./calculatePlayerScores", () => ({ calculatePlayerScores: mocks.calculatePlayerScores }));
vi.mock("./calculateTeamScores", () => ({ calculateTeamScores: mocks.calculateTeamScores }));
vi.mock("./updateStandings", () => ({ updateStandings: mocks.updateStandings }));
vi.mock("./awardPostponedMatchTransfers", () => ({ awardPostponedMatchTransfers: mocks.awardPostponedMatchTransfers }));

import { processMatchDataChanges } from "./processMatchDataChanges";

const GAMEWEEK_ID = "gw-1";
const LAST_MATCH_ID = "match-arsenal-coventry";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findGameweekById.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, number: 1, status: "IN_PROGRESS" }));
  mocks.areAllMatchesCompleted.mockResolvedValue(true);
  mocks.findMatchById.mockResolvedValue(buildMatch({ id: LAST_MATCH_ID, gameweekId: GAMEWEEK_ID }));
  mocks.findAllLeagues.mockResolvedValue([buildLeague({ id: "league-1" })]);
  mocks.findAllTeams.mockResolvedValue([buildTeam({ id: "team-alpha" }), buildTeam({ id: "team-bravo" })]);
});

describe("processMatchDataChanges — the gameweek completion cascade", () => {
  it("scores the match, completes the gameweek, awards each team its 2 transfers and updates standings", async () => {
    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith(LAST_MATCH_ID);
    expect(mocks.markGameweekCompleted).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.incrementBankedFreeTransferCount.mock.calls).toEqual([
      ["team-alpha", 2],
      ["team-bravo", 2],
    ]);
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.updateStandings).toHaveBeenCalledWith("league-1", GAMEWEEK_ID);
  });

  it("does not re-award free transfers when a completion arrives for an already-completed gameweek", async () => {
    mocks.findGameweekById.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, number: 1, status: "COMPLETED" }));

    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    // The match itself is still re-scored (PlayerScore rows are rewritten in place, so that is
    // harmless), but nothing that hands out transfers or re-opens standings may run again.
    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith(LAST_MATCH_ID);
    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
    expect(mocks.markGameweekCompleted).not.toHaveBeenCalled();
    expect(mocks.calculateTeamScores).not.toHaveBeenCalled();
    expect(mocks.updateStandings).not.toHaveBeenCalled();
  });

  it("awards a gameweek's transfers only once even if the same match is reported completed twice in one batch", async () => {
    await processMatchDataChanges({
      newlyCompletedMatchIds: [LAST_MATCH_ID, LAST_MATCH_ID],
      newlyDisruptedMatchIds: [],
    });

    expect(mocks.incrementBankedFreeTransferCount).toHaveBeenCalledTimes(2); // one per team, not two
    expect(mocks.markGameweekCompleted).toHaveBeenCalledTimes(1);
  });

  it("holds the cascade back while the gameweek still has matches to play", async () => {
    mocks.areAllMatchesCompleted.mockResolvedValue(false);

    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith(LAST_MATCH_ID);
    expect(mocks.markGameweekCompleted).not.toHaveBeenCalled();
    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
  });

  it("awards postponed-match transfers for every newly disrupted match", async () => {
    await processMatchDataChanges({ newlyCompletedMatchIds: [], newlyDisruptedMatchIds: ["match-postponed"] });

    expect(mocks.awardPostponedMatchTransfers).toHaveBeenCalledWith("match-postponed");
    expect(mocks.calculatePlayerScores).not.toHaveBeenCalled();
  });
});
