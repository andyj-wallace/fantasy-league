import { beforeEach, describe, expect, it, vi } from "vitest";
import { STARTING_SQUAD_BUDGET_IN_MILLIONS, type LeagueStanding } from "../domain";
import { buildGameweek, buildTeam } from "../testing/fixtures";

/**
 * Unit tests for the leaderboard ranking + tiebreaker chain in updateStandings. Repositories are
 * mocked so we can pose exact tie scenarios. Tiebreaker order (fantasy_league_v1_design.txt):
 * totalPoints → goalsScoredBySelectedPlayers → bankedFreeTransferCount → least totalSpent. A full
 * tie on all four shares a rank; the next distinct team resumes at index+1 (a rank gap).
 */
const LEAGUE_ID = "league1";
const GAMEWEEK_ID = "gw1";

const mocks = vi.hoisted(() => ({
  findGameweek: vi.fn(),
  findTeamsByLeague: vi.fn(),
  sumTeamPoints: vi.fn(),
  findRosterSlots: vi.fn(),
  sumGoals: vi.fn(),
  replaceForGameweek: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  gameweeksRepository: { findById: mocks.findGameweek },
  teamsRepository: { findByLeagueId: mocks.findTeamsByLeague, findRosterSlots: mocks.findRosterSlots },
  teamScoresRepository: { sumTotalPointsThroughGameweek: mocks.sumTeamPoints },
  playerMatchStatsRepository: { sumGoalsScoredThroughGameweek: mocks.sumGoals },
  leagueStandingsRepository: { replaceForGameweek: mocks.replaceForGameweek },
}));

import { updateStandings } from "./updateStandings";

interface TeamScenario {
  teamId: string;
  totalPoints: number;
  goalsScored: number;
  bankedFreeTransferCount: number;
  spentInMillions: number;
}

/** Runs updateStandings over the given per-team scenario and returns the produced standings. */
async function rank(teamScenarios: TeamScenario[]): Promise<LeagueStanding[]> {
  mocks.findGameweek.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, number: 1 }));
  mocks.findTeamsByLeague.mockResolvedValue(
    teamScenarios.map((scenario) =>
      buildTeam({
        id: scenario.teamId,
        leagueId: LEAGUE_ID,
        bankedFreeTransferCount: scenario.bankedFreeTransferCount,
        remainingBudgetInMillions: STARTING_SQUAD_BUDGET_IN_MILLIONS - scenario.spentInMillions,
      }),
    ),
  );
  const byTeam = new Map(teamScenarios.map((s) => [s.teamId, s]));
  mocks.sumTeamPoints.mockImplementation(async (teamId: string) => byTeam.get(teamId)!.totalPoints);
  mocks.findRosterSlots.mockImplementation(async (teamId: string) => [{ playerId: `${teamId}-p`, isStarting: true }]);
  // Resolve goals by the roster's single synthetic player id back to the scenario.
  mocks.sumGoals.mockImplementation(async (playerIds: string[]) => {
    const teamId = playerIds[0]!.replace(/-p$/, "");
    return byTeam.get(teamId)!.goalsScored;
  });

  await updateStandings(LEAGUE_ID, GAMEWEEK_ID);

  expect(mocks.replaceForGameweek).toHaveBeenCalledTimes(1);
  const [, , standings] = mocks.replaceForGameweek.mock.calls[0]! as [string, string, LeagueStanding[]];
  return standings;
}

/** Rank of a specific team in the produced standings. */
function rankOf(standings: LeagueStanding[], teamId: string): number {
  return standings.find((s) => s.teamId === teamId)!.rank;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updateStandings — ordering", () => {
  it("ranks by total points, highest first", async () => {
    const standings = await rank([
      { teamId: "low", totalPoints: 10, goalsScored: 0, bankedFreeTransferCount: 0, spentInMillions: 0 },
      { teamId: "high", totalPoints: 30, goalsScored: 0, bankedFreeTransferCount: 0, spentInMillions: 0 },
      { teamId: "mid", totalPoints: 20, goalsScored: 0, bankedFreeTransferCount: 0, spentInMillions: 0 },
    ]);

    expect(rankOf(standings, "high")).toBe(1);
    expect(rankOf(standings, "mid")).toBe(2);
    expect(rankOf(standings, "low")).toBe(3);
  });
});

describe("updateStandings — tiebreakers", () => {
  it("breaks a points tie by goals scored (more wins)", async () => {
    const standings = await rank([
      { teamId: "fewerGoals", totalPoints: 20, goalsScored: 3, bankedFreeTransferCount: 0, spentInMillions: 0 },
      { teamId: "moreGoals", totalPoints: 20, goalsScored: 8, bankedFreeTransferCount: 0, spentInMillions: 0 },
    ]);

    expect(rankOf(standings, "moreGoals")).toBe(1);
    expect(rankOf(standings, "fewerGoals")).toBe(2);
  });

  it("breaks a points+goals tie by banked free transfers (more wins)", async () => {
    const standings = await rank([
      { teamId: "fewerBanked", totalPoints: 20, goalsScored: 5, bankedFreeTransferCount: 1, spentInMillions: 0 },
      { teamId: "moreBanked", totalPoints: 20, goalsScored: 5, bankedFreeTransferCount: 4, spentInMillions: 0 },
    ]);

    expect(rankOf(standings, "moreBanked")).toBe(1);
    expect(rankOf(standings, "fewerBanked")).toBe(2);
  });

  it("breaks a points+goals+banked tie by least spent", async () => {
    const standings = await rank([
      { teamId: "spentMore", totalPoints: 20, goalsScored: 5, bankedFreeTransferCount: 2, spentInMillions: 100 },
      { teamId: "spentLess", totalPoints: 20, goalsScored: 5, bankedFreeTransferCount: 2, spentInMillions: 90 },
    ]);

    expect(rankOf(standings, "spentLess")).toBe(1);
    expect(rankOf(standings, "spentMore")).toBe(2);
  });
});

describe("updateStandings — shared rank on a full tie", () => {
  it("assigns tied teams the same rank and leaves a gap for the next", async () => {
    const standings = await rank([
      { teamId: "tieA", totalPoints: 20, goalsScored: 5, bankedFreeTransferCount: 2, spentInMillions: 50 },
      { teamId: "tieB", totalPoints: 20, goalsScored: 5, bankedFreeTransferCount: 2, spentInMillions: 50 },
      { teamId: "third", totalPoints: 10, goalsScored: 0, bankedFreeTransferCount: 0, spentInMillions: 0 },
    ]);

    expect(rankOf(standings, "tieA")).toBe(1);
    expect(rankOf(standings, "tieB")).toBe(1);
    // Two teams share rank 1, so the next distinct team is rank 3, not 2 (rank gap).
    expect(rankOf(standings, "third")).toBe(3);
  });
});

describe("updateStandings — guards and shape", () => {
  it("does nothing when the gameweek is not found", async () => {
    mocks.findGameweek.mockResolvedValue(undefined);

    await updateStandings(LEAGUE_ID, "missing");

    expect(mocks.replaceForGameweek).not.toHaveBeenCalled();
  });

  it("carries totalPoints and tiebreaker stats onto each standing row", async () => {
    const standings = await rank([
      { teamId: "solo", totalPoints: 42, goalsScored: 7, bankedFreeTransferCount: 3, spentInMillions: 95 },
    ]);

    const row = standings[0]!;
    expect(row.leagueId).toBe(LEAGUE_ID);
    expect(row.totalPoints).toBe(42);
    expect(row.tiebreakerStats.goalsScoredBySelectedPlayers).toBe(7);
    expect(row.tiebreakerStats.bankedFreeTransferCount).toBe(3);
    expect(row.tiebreakerStats.totalSpentInMillions).toBe(95);
  });
});
