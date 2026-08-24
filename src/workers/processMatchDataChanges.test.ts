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
  findGameweekIdsWithStandingsAfter: vi.fn(),
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
  leagueStandingsRepository: { findGameweekIdsWithStandingsAfter: mocks.findGameweekIdsWithStandingsAfter },
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
  mocks.findGameweekIdsWithStandingsAfter.mockResolvedValue([]);
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

  it("refreshes every later gameweek's table when a gameweek is scored late", async () => {
    // The postponed-fixture shape: Gameweek 1's replay finally lands after Gameweek 2 has already
    // been scored. Standings totals are cumulative through their own gameweek, so Gameweek 2's
    // stored row still carries Gameweek 1's part-scored total — and it is the row the leaderboard
    // serves, being the highest-numbered one.
    mocks.findGameweekIdsWithStandingsAfter.mockResolvedValue(["gw-2", "gw-3"]);

    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    expect(mocks.findGameweekIdsWithStandingsAfter).toHaveBeenCalledWith("league-1", 1);
    expect(mocks.updateStandings.mock.calls).toEqual([
      ["league-1", GAMEWEEK_ID],
      ["league-1", "gw-2"],
      ["league-1", "gw-3"],
    ]);
  });

  it("writes no later table when the league has none beyond the gameweek just scored", async () => {
    // The refresh must never create a row for a gameweek that has never been scored — that would
    // publish a leaderboard for a round nobody has played.
    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    expect(mocks.updateStandings.mock.calls).toEqual([["league-1", GAMEWEEK_ID]]);
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

  it("holds the completion cascade back while the gameweek still has matches to play", async () => {
    mocks.areAllMatchesCompleted.mockResolvedValue(false);

    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith(LAST_MATCH_ID);
    expect(mocks.markGameweekCompleted).not.toHaveBeenCalled();
    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
  });

  it("still rebuilds team scores and standings mid-gameweek, so the table moves through a matchday", async () => {
    mocks.areAllMatchesCompleted.mockResolvedValue(false);

    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    // Both are delete-then-insert rebuilds of the whole gameweek, so running them after every
    // match is idempotent — unlike the transfer award above, which stays gated on completion.
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.updateStandings).toHaveBeenCalledWith("league-1", GAMEWEEK_ID);
  });

  it("awards postponed-match transfers for every newly disrupted match", async () => {
    await processMatchDataChanges({ newlyCompletedMatchIds: [], newlyDisruptedMatchIds: ["match-postponed"] });

    expect(mocks.awardPostponedMatchTransfers).toHaveBeenCalledWith("match-postponed");
    expect(mocks.calculatePlayerScores).not.toHaveBeenCalled();
  });
});

describe("processMatchDataChanges — a gameweek closed by a disrupted fixture rather than a completed one", () => {
  /* VOIDED is a final state for areAllMatchesCompleted, so a fixture abandoned/awarded rather than
   * played can be the one that finishes a round. Because that transition arrives on
   * newlyDisruptedMatchIds and never on newlyCompletedMatchIds, deriving the re-check set from
   * completions alone left such a gameweek open forever: no free transfers, no final standings,
   * and — for the last fixture of a round — nothing that could ever unstick it. */

  const VOIDED_MATCH_ID = "match-abandoned";

  it("completes the gameweek and awards each team its 2 transfers when the round's last outstanding fixture is voided", async () => {
    // Every other match in the round is already COMPLETED, so voiding this one leaves the gameweek
    // with nothing pending — which is exactly what the real areAllMatchesCompleted reports.
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: VOIDED_MATCH_ID, gameweekId: GAMEWEEK_ID }));
    mocks.areAllMatchesCompleted.mockResolvedValue(true);

    await processMatchDataChanges({ newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [VOIDED_MATCH_ID] });

    expect(mocks.awardPostponedMatchTransfers).toHaveBeenCalledWith(VOIDED_MATCH_ID);
    expect(mocks.markGameweekCompleted).toHaveBeenCalledTimes(1);
    expect(mocks.markGameweekCompleted).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.incrementBankedFreeTransferCount.mock.calls).toEqual([
      ["team-alpha", 2],
      ["team-bravo", 2],
    ]);
    // The void scored nothing itself, but the gameweek's standings are now final and the award
    // above just moved bankedFreeTransferCount, which is one of the standings tiebreakers.
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.updateStandings).toHaveBeenCalledWith("league-1", GAMEWEEK_ID);
    // Nothing was played, so no player scoring may be triggered by a void.
    expect(mocks.calculatePlayerScores).not.toHaveBeenCalled();
  });

  it("does not complete a gameweek — or award anything — when the disrupted fixture is merely postponed", async () => {
    // A POSTPONED row is neither COMPLETED nor VOIDED, so the real areAllMatchesCompleted keeps
    // returning false while it is pending. Re-checking the gameweek is therefore harmless: the
    // postponement holds its own round open, exactly as before.
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: "match-postponed", gameweekId: GAMEWEEK_ID }));
    mocks.areAllMatchesCompleted.mockResolvedValue(false);

    await processMatchDataChanges({ newlyCompletedMatchIds: [], newlyDisruptedMatchIds: ["match-postponed"] });

    expect(mocks.areAllMatchesCompleted).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.markGameweekCompleted).not.toHaveBeenCalled();
    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
    // A postponement can land on a round weeks away, and it changes no player's score, so it must
    // not write a provisional table against a gameweek nothing has been played in yet.
    expect(mocks.calculateTeamScores).not.toHaveBeenCalled();
    expect(mocks.updateStandings).not.toHaveBeenCalled();
  });

  it("does not re-award free transfers when a disrupted match points at an already-completed gameweek", async () => {
    // A late VOID on a round that already closed — a fixture awarded after the fact, say. The
    // postponed-match transfers for it are still owed, but the gameweek-completion cascade is not.
    mocks.findGameweekById.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, number: 1, status: "COMPLETED" }));
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: VOIDED_MATCH_ID, gameweekId: GAMEWEEK_ID }));

    await processMatchDataChanges({ newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [VOIDED_MATCH_ID] });

    expect(mocks.awardPostponedMatchTransfers).toHaveBeenCalledWith(VOIDED_MATCH_ID);
    expect(mocks.markGameweekCompleted).not.toHaveBeenCalled();
    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
    expect(mocks.calculateTeamScores).not.toHaveBeenCalled();
    expect(mocks.updateStandings).not.toHaveBeenCalled();
  });

  it("awards the gameweek's transfers only once when its last two fixtures are voided and completed in the same batch", async () => {
    // Both routes into the re-check set naming the same gameweek must still collapse to one
    // cascade — the set is keyed by gameweek id precisely so that it does.
    mocks.findMatchById.mockImplementation(async (matchId: string) =>
      buildMatch({ id: matchId, gameweekId: GAMEWEEK_ID }),
    );

    await processMatchDataChanges({
      newlyCompletedMatchIds: [LAST_MATCH_ID],
      newlyDisruptedMatchIds: [VOIDED_MATCH_ID],
    });

    expect(mocks.markGameweekCompleted).toHaveBeenCalledTimes(1);
    expect(mocks.incrementBankedFreeTransferCount).toHaveBeenCalledTimes(2); // one per team, not four
  });
});
