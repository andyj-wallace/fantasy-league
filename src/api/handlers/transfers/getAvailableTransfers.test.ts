import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGameweek, buildMatch, buildPlayer, buildRosterSlot, buildTeam } from "../../../testing/fixtures";

/**
 * Covers the season-awareness enrichment: the response's top-level currentGameweek and each
 * roster entry's nextMatch (the fixture that explains a Locked badge or warns of an upcoming
 * lock). The lock computation itself (isClubLocked) is covered by the domain tests.
 */
const USER_ID = "user1";
const TEAM_ID = "team1";
const GAMEWEEK_ID = "gw4";

const mocks = vi.hoisted(() => ({
  findTeamById: vi.fn(),
  findRosterSlots: vi.fn(),
  findManyPlayersByIds: vi.fn(),
  findCurrentGameweek: vi.fn(),
  findMatchesByGameweekId: vi.fn(),
  findTransfersByTeamAndGameweek: vi.fn(),
  findManyPlayerScoresByPlayerIds: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  teamsRepository: { findById: mocks.findTeamById, findRosterSlots: mocks.findRosterSlots },
  playersRepository: { findManyByIds: mocks.findManyPlayersByIds },
  gameweeksRepository: { findCurrent: mocks.findCurrentGameweek },
  matchesRepository: { findByGameweekId: mocks.findMatchesByGameweekId },
  transfersRepository: { findByTeamAndGameweek: mocks.findTransfersByTeamAndGameweek },
  playerScoresRepository: { findManyByPlayerIds: mocks.findManyPlayerScoresByPlayerIds },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: USER_ID }),
}));

import { getAvailableTransfers } from "./getAvailableTransfers";

async function callGetAvailableTransfers(): Promise<{ statusCode: number; body: any }> {
  const result = (await getAvailableTransfers({
    httpMethod: "GET",
    path: `/teams/${TEAM_ID}/transfers/available`,
    pathParameters: { teamId: TEAM_ID },
    queryStringParameters: null,
    headers: {},
    body: null,
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

describe("getAvailableTransfers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findTeamById.mockResolvedValue(buildTeam({ id: TEAM_ID, userId: USER_ID }));
    mocks.findTransfersByTeamAndGameweek.mockResolvedValue([]);
    mocks.findManyPlayerScoresByPlayerIds.mockResolvedValue([]);
  });

  it("includes the current gameweek and each player's fixture as nextMatch", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    mocks.findCurrentGameweek.mockResolvedValue(
      buildGameweek({ id: GAMEWEEK_ID, number: 4, status: "IN_PROGRESS", deadlineAt: new Date("2026-07-22T11:30:00Z") }),
    );
    mocks.findMatchesByGameweekId.mockResolvedValue([
      buildMatch({ gameweekId: GAMEWEEK_ID, homeClub: "Arsenal", awayClub: "Chelsea", kickoffAt: oneHourAgo, status: "IN_PROGRESS", finalHomeScore: null, finalAwayScore: null }),
      buildMatch({ gameweekId: GAMEWEEK_ID, homeClub: "Everton", awayClub: "Liverpool", kickoffAt: tomorrow, status: "SCHEDULED", finalHomeScore: null, finalAwayScore: null }),
    ]);
    const lockedPlayer = buildPlayer({ id: "p1", name: "Locked Gunner", club: "Arsenal" });
    const upcomingPlayer = buildPlayer({ id: "p2", name: "Free Red", club: "Liverpool" });
    const fixturelessPlayer = buildPlayer({ id: "p3", name: "No Fixture", club: "Test FC" });
    mocks.findRosterSlots.mockResolvedValue([buildRosterSlot("p1"), buildRosterSlot("p2"), buildRosterSlot("p3", false)]);
    mocks.findManyPlayersByIds.mockResolvedValue([lockedPlayer, upcomingPlayer, fixturelessPlayer]);

    const { statusCode, body } = await callGetAvailableTransfers();

    expect(statusCode).toBe(200);
    expect(body.currentGameweek).toEqual({
      number: 4,
      status: "IN_PROGRESS",
      deadlineAt: "2026-07-22T11:30:00.000Z",
    });

    const rosterByPlayerId = new Map(body.roster.map((entry: { id: string }) => [entry.id, entry]));
    expect(rosterByPlayerId.get("p1")).toMatchObject({
      isLocked: true,
      nextMatch: { opponent: "Chelsea", home: true, status: "IN_PROGRESS" },
    });
    expect(rosterByPlayerId.get("p2")).toMatchObject({
      isLocked: false,
      nextMatch: { opponent: "Everton", home: false, status: "SCHEDULED" },
    });
    expect(rosterByPlayerId.get("p3")).toMatchObject({ isLocked: false, nextMatch: null });
  });

  it("returns a null currentGameweek before any gameweek exists", async () => {
    mocks.findCurrentGameweek.mockResolvedValue(null);
    mocks.findRosterSlots.mockResolvedValue([]);
    mocks.findManyPlayersByIds.mockResolvedValue([]);

    const { statusCode, body } = await callGetAvailableTransfers();

    expect(statusCode).toBe(200);
    expect(body.currentGameweek).toBeNull();
    expect(body.roster).toEqual([]);
  });
});
