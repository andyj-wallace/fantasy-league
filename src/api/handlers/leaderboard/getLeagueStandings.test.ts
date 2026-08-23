import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeagueStanding } from "../../../domain";
import { buildGameweek, buildTeam } from "../../../testing/fixtures";

const mocks = vi.hoisted(() => ({
  findLatestForLeague: vi.fn(),
  findForLeagueAndGameweek: vi.fn(),
  findTeamsByLeagueId: vi.fn(),
  findManyUsersByIds: vi.fn(),
  findGameweekById: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  leagueStandingsRepository: {
    findLatestForLeague: mocks.findLatestForLeague,
    findForLeagueAndGameweek: mocks.findForLeagueAndGameweek,
  },
  teamsRepository: { findByLeagueId: mocks.findTeamsByLeagueId },
  usersRepository: { findManyByIds: mocks.findManyUsersByIds },
  gameweeksRepository: { findById: mocks.findGameweekById },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: "user1" }),
}));

import { getLeagueStandings } from "./getLeagueStandings";

const LEAGUE_ID = "league1";

function buildStanding(overrides: Partial<LeagueStanding> = {}): LeagueStanding {
  return {
    id: "standing1",
    leagueId: LEAGUE_ID,
    gameweekId: "gw3",
    teamId: "team1",
    rank: 1,
    totalPoints: 42,
    tiebreakerStats: { goalsScoredBySelectedPlayers: 5, bankedFreeTransferCount: 2, totalSpentInMillions: 100 },
    calculatedAt: new Date("2026-07-22T12:00:00Z"),
    ...overrides,
  };
}

async function callGetLeagueStandings(): Promise<{ statusCode: number; body: any }> {
  const result = (await getLeagueStandings({
    httpMethod: "GET",
    path: `/leagues/${LEAGUE_ID}/standings`,
    pathParameters: { leagueId: LEAGUE_ID },
    queryStringParameters: null,
    headers: {},
    body: null,
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

describe("getLeagueStandings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findTeamsByLeagueId.mockResolvedValue([]);
    mocks.findManyUsersByIds.mockResolvedValue([]);
  });

  it("labels the standings with the gameweek they were calculated for", async () => {
    mocks.findLatestForLeague.mockResolvedValue([buildStanding({ gameweekId: "gw3" })]);
    const team = buildTeam({ id: "team1", leagueId: LEAGUE_ID, userId: "user1", name: "The Team" });
    mocks.findTeamsByLeagueId.mockResolvedValue([team]);
    mocks.findManyUsersByIds.mockResolvedValue([{ id: "user1", displayName: "Drew" }]);
    mocks.findGameweekById.mockResolvedValue(buildGameweek({ id: "gw3", number: 3, status: "COMPLETED" }));

    const { statusCode, body } = await callGetLeagueStandings();

    expect(statusCode).toBe(200);
    expect(body.gameweek).toEqual({ number: 3, status: "COMPLETED" });
    expect(body.standings).toHaveLength(1);
    expect(body.standings[0].teamName).toBe("The Team");
    expect(body.standings[0].managerName).toBe("Drew");
    expect(mocks.findGameweekById).toHaveBeenCalledWith("gw3");
  });

  it("returns a null gameweek and no rows when the league has no teams to put in a table", async () => {
    mocks.findLatestForLeague.mockResolvedValue([]);

    const { statusCode, body } = await callGetLeagueStandings();

    expect(statusCode).toBe(200);
    expect(body).toEqual({ gameweek: null, isAwaitingFirstScoredGameweek: true, standings: [] });
    expect(mocks.findGameweekById).not.toHaveBeenCalled();
  });

  it("falls back to a zero-point baseline row per team before anything has been scored", async () => {
    mocks.findLatestForLeague.mockResolvedValue([]);
    mocks.findTeamsByLeagueId.mockResolvedValue([
      buildTeam({ id: "team1", leagueId: LEAGUE_ID, userId: "user1", name: "First Team" }),
      buildTeam({ id: "team2", leagueId: LEAGUE_ID, userId: "user2", name: "Second Team" }),
    ]);
    mocks.findManyUsersByIds.mockResolvedValue([
      { id: "user1", displayName: "Drew" },
      { id: "user2", displayName: "Sam" },
    ]);

    const { statusCode, body } = await callGetLeagueStandings();

    expect(statusCode).toBe(200);
    expect(body.isAwaitingFirstScoredGameweek).toBe(true);
    expect(body.gameweek).toBeNull();
    expect(body.standings).toHaveLength(2);
    expect(body.standings.map((standing: any) => standing.totalPoints)).toEqual([0, 0]);
    expect(body.standings.map((standing: any) => standing.teamName).sort()).toEqual(["First Team", "Second Team"]);
    expect(body.standings.map((standing: any) => standing.managerName).sort()).toEqual(["Drew", "Sam"]);
    // Identical teams are level on every tiebreaker, so they share top spot rather than being
    // ordered arbitrarily.
    expect(body.standings.map((standing: any) => standing.rank)).toEqual([1, 1]);
    // No stored standings row means no gameweek to look up — the baseline must not cost a read.
    expect(mocks.findGameweekById).not.toHaveBeenCalled();
  });

  it("ranks baseline teams by the tiebreakers that already have values", async () => {
    mocks.findLatestForLeague.mockResolvedValue([]);
    mocks.findTeamsByLeagueId.mockResolvedValue([
      // Spent more of the budget, so loses the "least spent" tiebreaker.
      buildTeam({ id: "spender", leagueId: LEAGUE_ID, userId: "user1", remainingBudgetInMillions: 0 }),
      buildTeam({ id: "saver", leagueId: LEAGUE_ID, userId: "user2", remainingBudgetInMillions: 10 }),
    ]);
    mocks.findManyUsersByIds.mockResolvedValue([
      { id: "user1", displayName: "Drew" },
      { id: "user2", displayName: "Sam" },
    ]);

    const { body } = await callGetLeagueStandings();

    expect(body.standings.map((standing: any) => [standing.teamId, standing.rank])).toEqual([
      ["saver", 1],
      ["spender", 2],
    ]);
  });

  it("prefers the precomputed table over the baseline once one exists", async () => {
    mocks.findLatestForLeague.mockResolvedValue([buildStanding({ teamId: "team1", totalPoints: 42 })]);
    mocks.findTeamsByLeagueId.mockResolvedValue([
      buildTeam({ id: "team1", leagueId: LEAGUE_ID, userId: "user1", name: "The Team" }),
      buildTeam({ id: "team2", leagueId: LEAGUE_ID, userId: "user2", name: "Other Team" }),
    ]);
    mocks.findManyUsersByIds.mockResolvedValue([
      { id: "user1", displayName: "Drew" },
      { id: "user2", displayName: "Sam" },
    ]);
    mocks.findGameweekById.mockResolvedValue(buildGameweek({ id: "gw3", number: 3, status: "IN_PROGRESS" }));

    const { body } = await callGetLeagueStandings();

    expect(body.isAwaitingFirstScoredGameweek).toBe(false);
    expect(body.standings).toHaveLength(1);
    expect(body.standings[0].totalPoints).toBe(42);
  });
});
