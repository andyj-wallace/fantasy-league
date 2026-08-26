import { beforeEach, describe, expect, it, vi } from "vitest";
import { MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION } from "../domain";
import type { MatchStatus } from "../domain";
import { buildGameweek, buildLeague, buildMatch, buildTeam } from "../testing/fixtures";

/**
 * Blast-radius tests for the completion cascade, written alongside live-poll reconciliation
 * (docs/stuck-live-match-reconciliation-plan.md).
 *
 * awardGameweekFreeTransfers keeps no ledger — it increments every team's banked transfers by 2
 * with no record of having done so — so the round it settles has to be settled exactly once. Since
 * 2026-08-26 that is enforced by gameweeksRepository.markCompletedIfNotAlready, a single
 * conditional UPDATE that reports whether *this* call closed the round, rather than by a read of
 * the status taken a statement earlier. awardGameweekFreeTransfers therefore runs for real here,
 * against a mocked teams repository, so every assertion is about transfers actually granted.
 */
const mocks = vi.hoisted(() => ({
  findGameweekById: vi.fn(),
  hasEveryMatchStoppedBlockingGameweekCompletion: vi.fn(),
  markGameweekCompletedIfNotAlready: vi.fn(),
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
    hasEveryMatchStoppedBlockingGameweekCompletion: mocks.hasEveryMatchStoppedBlockingGameweekCompletion,
    markCompletedIfNotAlready: mocks.markGameweekCompletedIfNotAlready,
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

/**
 * Drives the completion predicate off the round's actual fixture statuses instead of a bare
 * boolean, so a test about *which* statuses still hold a round open is exercising that rule rather
 * than restating its answer. Mirrors gameweeksRepository.hasEveryMatchStoppedBlockingGameweekCompletion,
 * which reads the same shared list.
 */
function givenTheRoundsFixturesAre(...statuses: MatchStatus[]): void {
  mocks.hasEveryMatchStoppedBlockingGameweekCompletion.mockImplementation(
    async () =>
      statuses.length > 0 &&
      !statuses.some((status) => MATCH_STATUSES_STILL_BLOCKING_GAMEWEEK_COMPLETION.includes(status)),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findGameweekById.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, number: 1, status: "IN_PROGRESS" }));
  mocks.hasEveryMatchStoppedBlockingGameweekCompletion.mockResolvedValue(true);
  // The default is a round that was open and is now closed by this call, so a test only spells the
  // conditional UPDATE out when it is specifically about a round that had already closed.
  mocks.markGameweekCompletedIfNotAlready.mockResolvedValue(true);
  mocks.findMatchById.mockResolvedValue(buildMatch({ id: LAST_MATCH_ID, gameweekId: GAMEWEEK_ID }));
  mocks.findAllLeagues.mockResolvedValue([buildLeague({ id: "league-1" })]);
  mocks.findGameweekIdsWithStandingsAfter.mockResolvedValue([]);
  mocks.findAllTeams.mockResolvedValue([buildTeam({ id: "team-alpha" }), buildTeam({ id: "team-bravo" })]);
});

describe("processMatchDataChanges — the gameweek completion cascade", () => {
  it("scores the match, completes the gameweek, awards each team its 2 transfers and updates standings", async () => {
    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith(LAST_MATCH_ID);
    expect(mocks.markGameweekCompletedIfNotAlready).toHaveBeenCalledWith(GAMEWEEK_ID);
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
    // The conditional UPDATE finds the round already COMPLETED, changes nothing, and says so.
    mocks.findGameweekById.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, number: 1, status: "COMPLETED" }));
    mocks.markGameweekCompletedIfNotAlready.mockResolvedValue(false);

    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
    // The match itself is still re-scored and the round's tables still rebuilt — both are
    // delete-then-insert and a late fixture landing on a closed round is exactly what needs them.
    // Only the one-shot award is withheld.
    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith(LAST_MATCH_ID);
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.updateStandings).toHaveBeenCalledWith("league-1", GAMEWEEK_ID);
  });

  it("awards a gameweek's transfers only once even if the same match is reported completed twice in one batch", async () => {
    await processMatchDataChanges({
      newlyCompletedMatchIds: [LAST_MATCH_ID, LAST_MATCH_ID],
      newlyDisruptedMatchIds: [],
    });

    expect(mocks.incrementBankedFreeTransferCount).toHaveBeenCalledTimes(2); // one per team, not two
    expect(mocks.markGameweekCompletedIfNotAlready).toHaveBeenCalledTimes(1);
  });

  it("holds the completion cascade back while the gameweek still has matches to play", async () => {
    mocks.hasEveryMatchStoppedBlockingGameweekCompletion.mockResolvedValue(false);

    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith(LAST_MATCH_ID);
    expect(mocks.markGameweekCompletedIfNotAlready).not.toHaveBeenCalled();
    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
  });

  it("still rebuilds team scores and standings mid-gameweek, so the table moves through a matchday", async () => {
    mocks.hasEveryMatchStoppedBlockingGameweekCompletion.mockResolvedValue(false);

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

describe("processMatchDataChanges — two gameweeks settling in the same batch", () => {
  /* The +4 case, and the reason this file grew a second gameweek.
   *
   * A Gameweek 10 fixture postponed into the Gameweek 12 weekend is replayed there, so one worker
   * cycle can carry the last outstanding fixture of two different rounds. Every manager banks
   * 2 + 2, and that is correct: fantasy_league_v1_design.txt earns 2 free transfers *per gameweek*,
   * so +4 is two rounds' settlement, one of them merely paid late. Capping the batch would quietly
   * cancel a round's allowance to make the total look tidy. What must never happen is one round
   * paying twice — hence the per-gameweek attribution below rather than a bare call count.
   *
   * The same-match-twice test above cannot see any of this: both of its entries name one gameweek,
   * so the Set collapses them before the cascade loop even begins. */

  const EARLIER_GAMEWEEK_ID = "gw-10";
  const LATER_GAMEWEEK_ID = "gw-12";
  const REPLAYED_MATCH_ID = "match-postponed-from-gw-10";
  const LATE_KICKOFF_MATCH_ID = "match-monday-night-of-gw-12";

  /** Each write the cascade makes, in order, so "which round paid for what" is assertable rather
   * than inferred from a total. */
  let cascadeWriteLog: string[];

  beforeEach(() => {
    cascadeWriteLog = [];
    mocks.findMatchById.mockImplementation(async (matchId: string) =>
      buildMatch({
        id: matchId,
        gameweekId: matchId === REPLAYED_MATCH_ID ? EARLIER_GAMEWEEK_ID : LATER_GAMEWEEK_ID,
      }),
    );
    mocks.findGameweekById.mockImplementation(async (gameweekId: string) =>
      buildGameweek({
        id: gameweekId,
        number: gameweekId === EARLIER_GAMEWEEK_ID ? 10 : 12,
        status: "IN_PROGRESS",
      }),
    );
    mocks.markGameweekCompletedIfNotAlready.mockImplementation(async (gameweekId: string) => {
      cascadeWriteLog.push(`closed ${gameweekId}`);
      return true;
    });
    mocks.incrementBankedFreeTransferCount.mockImplementation(async (teamId: string, amount: number) => {
      cascadeWriteLog.push(`+${amount} to ${teamId}`);
    });
  });

  it("closes each gameweek exactly once and pays every team its own 2 free transfers for each", async () => {
    await processMatchDataChanges({
      newlyCompletedMatchIds: [REPLAYED_MATCH_ID, LATE_KICKOFF_MATCH_ID],
      newlyDisruptedMatchIds: [],
    });

    expect(cascadeWriteLog).toEqual([
      `closed ${EARLIER_GAMEWEEK_ID}`,
      "+2 to team-alpha",
      "+2 to team-bravo",
      `closed ${LATER_GAMEWEEK_ID}`,
      "+2 to team-alpha",
      "+2 to team-bravo",
    ]);
  });

  it("rebuilds each gameweek's own table rather than folding both into one", async () => {
    await processMatchDataChanges({
      newlyCompletedMatchIds: [REPLAYED_MATCH_ID, LATE_KICKOFF_MATCH_ID],
      newlyDisruptedMatchIds: [],
    });

    expect(mocks.calculateTeamScores.mock.calls).toEqual([[EARLIER_GAMEWEEK_ID], [LATER_GAMEWEEK_ID]]);
    expect(mocks.updateStandings.mock.calls).toEqual([
      ["league-1", EARLIER_GAMEWEEK_ID],
      ["league-1", LATER_GAMEWEEK_ID],
    ]);
  });
});

describe("processMatchDataChanges — a round whose last outstanding fixture is postponed", () => {
  /* Until 2026-08-26 a POSTPONED fixture held its round open until it was replayed, which can be
   * weeks. Everything downstream waited with it: the 2-per-gameweek free-transfer award, the
   * round's final standings, and — because gameweeksRepository.findCurrent is "the lowest-numbered
   * non-COMPLETED gameweek" — the whole season-awareness UI, pinned to a round the season had
   * already played past. Managers who actually lost players to the postponement are compensated
   * separately and per club by awardPostponedMatchTransfers, so withholding the round's allowance
   * from everyone bought nothing at all. */

  it("closes the round and pays its 2 free transfers with the postponed fixture still to be played", async () => {
    givenTheRoundsFixturesAre("COMPLETED", "COMPLETED", "POSTPONED");

    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    expect(mocks.markGameweekCompletedIfNotAlready).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.incrementBankedFreeTransferCount.mock.calls).toEqual([
      ["team-alpha", 2],
      ["team-bravo", 2],
    ]);
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
  });

  it("still holds the round open when a fixture is genuinely yet to be played", async () => {
    // A postponement no longer blocks, but a SCHEDULED fixture beside it does — which is why a
    // postponement landing on a round weeks away completes nothing.
    givenTheRoundsFixturesAre("COMPLETED", "SCHEDULED", "POSTPONED");

    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    expect(mocks.markGameweekCompletedIfNotAlready).not.toHaveBeenCalled();
    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
  });

  it("rebuilds the round when the postponed fixture is finally replayed, without paying a second time", async () => {
    // The replay completes into a round that closed weeks ago. The conditional UPDATE reports that
    // it changed nothing, so no second award — but the scores it just produced still have to reach
    // that round's table, and the cumulative refresh inside rebuildGameweekScoresAndStandings
    // carries the correction into every later round, the path commit fb260a0 established.
    mocks.findGameweekById.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, number: 1, status: "COMPLETED" }));
    mocks.markGameweekCompletedIfNotAlready.mockResolvedValue(false);
    mocks.findGameweekIdsWithStandingsAfter.mockResolvedValue(["gw-2"]);
    givenTheRoundsFixturesAre("COMPLETED", "COMPLETED", "COMPLETED");

    await processMatchDataChanges({ newlyCompletedMatchIds: [LAST_MATCH_ID], newlyDisruptedMatchIds: [] });

    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
    expect(mocks.calculatePlayerScores).toHaveBeenCalledWith(LAST_MATCH_ID);
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.updateStandings.mock.calls).toEqual([
      ["league-1", GAMEWEEK_ID],
      ["league-1", "gw-2"],
    ]);
  });
});

describe("processMatchDataChanges — a gameweek closed by a disrupted fixture rather than a completed one", () => {
  /* Neither VOIDED nor POSTPONED blocks a round from closing, so a fixture abandoned, awarded or
   * put off rather than played can be the one that finishes a round. Because that transition
   * arrives on newlyDisruptedMatchIds and never on newlyCompletedMatchIds, deriving the re-check
   * set from completions alone left such a gameweek open forever: no free transfers, no final
   * standings, and — for the last fixture of a round — nothing that could ever unstick it. */

  const VOIDED_MATCH_ID = "match-abandoned";

  it("completes the gameweek and awards each team its 2 transfers when the round's last outstanding fixture is voided", async () => {
    // Every other match in the round is already COMPLETED, so voiding this one leaves the gameweek
    // with nothing blocking it — which is exactly what the real predicate reports.
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: VOIDED_MATCH_ID, gameweekId: GAMEWEEK_ID }));
    givenTheRoundsFixturesAre("COMPLETED", "COMPLETED", "VOIDED");

    await processMatchDataChanges({ newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [VOIDED_MATCH_ID] });

    expect(mocks.awardPostponedMatchTransfers).toHaveBeenCalledWith(VOIDED_MATCH_ID);
    expect(mocks.markGameweekCompletedIfNotAlready).toHaveBeenCalledTimes(1);
    expect(mocks.markGameweekCompletedIfNotAlready).toHaveBeenCalledWith(GAMEWEEK_ID);
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

  it("does not complete a gameweek — or award anything — when a postponement lands on a round still to be played", async () => {
    // The common shape for a postponement: it is announced for a round weeks away, whose other
    // fixtures are all still SCHEDULED. Re-checking that gameweek is harmless — the SCHEDULED
    // fixtures hold it open, so nothing completes and no premature table is written.
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: "match-postponed", gameweekId: GAMEWEEK_ID }));
    givenTheRoundsFixturesAre("SCHEDULED", "SCHEDULED", "POSTPONED");

    await processMatchDataChanges({ newlyCompletedMatchIds: [], newlyDisruptedMatchIds: ["match-postponed"] });

    expect(mocks.hasEveryMatchStoppedBlockingGameweekCompletion).toHaveBeenCalledWith(GAMEWEEK_ID);
    expect(mocks.markGameweekCompletedIfNotAlready).not.toHaveBeenCalled();
    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
    // A postponement changes no player's score, so it must not write a provisional table against a
    // gameweek nothing has been played in yet.
    expect(mocks.calculateTeamScores).not.toHaveBeenCalled();
    expect(mocks.updateStandings).not.toHaveBeenCalled();
  });

  it("does not re-award free transfers when a disrupted match points at an already-completed gameweek", async () => {
    // A late VOID on a round that already closed — a fixture awarded after the fact, say. The
    // postponed-match transfers for it are still owed, but the gameweek's allowance is not.
    mocks.findGameweekById.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, number: 1, status: "COMPLETED" }));
    mocks.markGameweekCompletedIfNotAlready.mockResolvedValue(false);
    mocks.findMatchById.mockResolvedValue(buildMatch({ id: VOIDED_MATCH_ID, gameweekId: GAMEWEEK_ID }));

    await processMatchDataChanges({ newlyCompletedMatchIds: [], newlyDisruptedMatchIds: [VOIDED_MATCH_ID] });

    expect(mocks.awardPostponedMatchTransfers).toHaveBeenCalledWith(VOIDED_MATCH_ID);
    expect(mocks.incrementBankedFreeTransferCount).not.toHaveBeenCalled();
    // The void moved a fixture out of this round's scoring, so the round's table is stale and gets
    // an idempotent rebuild — the same treatment a late completion gets.
    expect(mocks.calculateTeamScores).toHaveBeenCalledWith(GAMEWEEK_ID);
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

    expect(mocks.markGameweekCompletedIfNotAlready).toHaveBeenCalledTimes(1);
    expect(mocks.incrementBankedFreeTransferCount).toHaveBeenCalledTimes(2); // one per team, not four
  });
});
