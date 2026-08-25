import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGameweek, buildRosterSlot, buildTeam } from "../../../testing/fixtures";

/**
 * Covers the security-critical boundary of the rival squad view: a rival's roster/formation/
 * captaincy must never reach a non-member (404, not 403 — no confirming a team id exists), and
 * must stay hidden from a fellow member until resolveRivalSquadVisibility says the deadline has
 * passed. The visibility rules themselves are covered by rivalSquadVisibility.test.ts.
 */
const LEAGUE_ID = "league1";
const VIEWER_USER_ID = "viewer1";
const RIVAL_USER_ID = "rival1";
const VIEWER_TEAM_ID = "team-viewer";
const RIVAL_TEAM_ID = "team-rival";
const GAMEWEEK_ID = "gw4";

const mocks = vi.hoisted(() => ({
  findByLeagueId: vi.fn(),
  findRosterSlots: vi.fn(),
  findCurrentGameweek: vi.fn(),
  findLatestCompletedGameweek: vi.fn(),
  findManyUsersByIds: vi.fn(),
  findTransfersByTeamAndGameweek: vi.fn(),
  findTeamScoreByTeamAndGameweek: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  teamsRepository: { findByLeagueId: mocks.findByLeagueId, findRosterSlots: mocks.findRosterSlots },
  gameweeksRepository: { findCurrent: mocks.findCurrentGameweek, findLatestCompleted: mocks.findLatestCompletedGameweek },
  usersRepository: { findManyByIds: mocks.findManyUsersByIds },
  transfersRepository: { findByTeamAndGameweek: mocks.findTransfersByTeamAndGameweek },
  teamScoresRepository: { findByTeamAndGameweek: mocks.findTeamScoreByTeamAndGameweek },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: VIEWER_USER_ID }),
}));

import { getLeagueTeamSquad } from "./getLeagueTeamSquad";

function transferCosting(pointsCost: number, id: string) {
  return {
    id,
    teamId: RIVAL_TEAM_ID,
    gameweekId: GAMEWEEK_ID,
    playerOutId: `${id}-out`,
    playerInId: `${id}-in`,
    pointsCost,
    createdAt: new Date("2026-08-20T10:00:00Z"),
  };
}

async function callGetLeagueTeamSquad(teamId: string): Promise<{ statusCode: number; body: any }> {
  const result = (await getLeagueTeamSquad({
    httpMethod: "GET",
    path: `/leagues/${LEAGUE_ID}/teams/${teamId}`,
    pathParameters: { leagueId: LEAGUE_ID, teamId },
    queryStringParameters: null,
    headers: {},
    body: null,
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

describe("getLeagueTeamSquad", () => {
  const viewerTeam = buildTeam({ id: VIEWER_TEAM_ID, leagueId: LEAGUE_ID, userId: VIEWER_USER_ID, name: "Viewer FC" });
  const rivalTeam = buildTeam({
    id: RIVAL_TEAM_ID,
    leagueId: LEAGUE_ID,
    userId: RIVAL_USER_ID,
    name: "Rival FC",
    formation: "4-4-2",
    captainPlayerId: "p1",
    viceCaptainPlayerId: "p2",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByLeagueId.mockResolvedValue([viewerTeam, rivalTeam]);
    mocks.findManyUsersByIds.mockResolvedValue([
      { id: RIVAL_USER_ID, displayName: "Bob", email: "b@example.com", cognitoSub: null, handle: null, createdAt: new Date() },
    ]);
    mocks.findRosterSlots.mockResolvedValue([buildRosterSlot("p1"), buildRosterSlot("p2", false)]);
    mocks.findTransfersByTeamAndGameweek.mockResolvedValue([]);
    mocks.findTeamScoreByTeamAndGameweek.mockResolvedValue(null);
    mocks.findLatestCompletedGameweek.mockResolvedValue(null);
  });

  it("404s when the viewer has no team in the league", async () => {
    mocks.findByLeagueId.mockResolvedValue([rivalTeam]);
    mocks.findCurrentGameweek.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, status: "COMPLETED" }));

    const { statusCode } = await callGetLeagueTeamSquad(RIVAL_TEAM_ID);

    expect(statusCode).toBe(404);
  });

  it("404s when the requested team belongs to another league or was soft-removed (absent from findByLeagueId)", async () => {
    mocks.findByLeagueId.mockResolvedValue([viewerTeam]);
    mocks.findCurrentGameweek.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, status: "COMPLETED" }));

    const { statusCode } = await callGetLeagueTeamSquad(RIVAL_TEAM_ID);

    expect(statusCode).toBe(404);
  });

  it("hides a rival's roster, formation and captaincy before the gameweek deadline", async () => {
    const deadline = new Date(Date.now() + 60 * 60 * 1000);
    mocks.findCurrentGameweek.mockResolvedValue(
      buildGameweek({ id: GAMEWEEK_ID, number: 4, status: "UPCOMING", deadlineAt: deadline }),
    );

    const { statusCode, body } = await callGetLeagueTeamSquad(RIVAL_TEAM_ID);

    expect(statusCode).toBe(200);
    expect(body.isSquadVisible).toBe(false);
    expect(body.rosterSlots).toEqual([]);
    expect(body.team.formation).toBeNull();
    expect(body.team.captainPlayerId).toBeNull();
    expect(body.team.viceCaptainPlayerId).toBeNull();
    expect(body.revealsAt).toBe(deadline.toISOString());
    expect(mocks.findRosterSlots).not.toHaveBeenCalled();
  });

  it("returns the full payload for the viewer's own team despite the deadline", async () => {
    mocks.findCurrentGameweek.mockResolvedValue(
      buildGameweek({ id: GAMEWEEK_ID, number: 4, status: "UPCOMING", deadlineAt: new Date(Date.now() + 60 * 60 * 1000) }),
    );
    mocks.findRosterSlots.mockResolvedValue([buildRosterSlot("owner-p1")]);

    const { statusCode, body } = await callGetLeagueTeamSquad(VIEWER_TEAM_ID);

    expect(statusCode).toBe(200);
    expect(body.isViewersOwnTeam).toBe(true);
    expect(body.isSquadVisible).toBe(true);
    expect(body.rosterSlots).toEqual([{ playerId: "owner-p1", isStarting: true }]);
  });

  it("returns roster, formation and captaincy for a rival once the deadline has passed, with the manager name resolved", async () => {
    mocks.findCurrentGameweek.mockResolvedValue(
      buildGameweek({ id: GAMEWEEK_ID, number: 4, status: "IN_PROGRESS", deadlineAt: new Date("2026-08-20T11:30:00Z") }),
    );

    const { statusCode, body } = await callGetLeagueTeamSquad(RIVAL_TEAM_ID);

    expect(statusCode).toBe(200);
    expect(body.isSquadVisible).toBe(true);
    expect(body.managerName).toBe("Bob");
    expect(body.team.formation).toBe("4-4-2");
    expect(body.team.captainPlayerId).toBe("p1");
    expect(body.team.viceCaptainPlayerId).toBe("p2");
    expect(body.rosterSlots).toEqual([
      { playerId: "p1", isStarting: true },
      { playerId: "p2", isStarting: false },
    ]);
  });

  it("reports gameweekTotalPoints from the TeamScore row, and null when there is none", async () => {
    mocks.findCurrentGameweek.mockResolvedValue(
      buildGameweek({ id: GAMEWEEK_ID, number: 4, status: "IN_PROGRESS", deadlineAt: new Date("2026-08-20T11:30:00Z") }),
    );
    mocks.findTeamScoreByTeamAndGameweek.mockResolvedValue({
      id: "score1",
      teamId: RIVAL_TEAM_ID,
      gameweekId: GAMEWEEK_ID,
      captainBonusPlayerId: "p1",
      totalPoints: 54,
      transferPointsCost: 0,
      calculatedAt: new Date("2026-08-21T00:00:00Z"),
    });

    const { body: bodyWithScore } = await callGetLeagueTeamSquad(RIVAL_TEAM_ID);
    expect(bodyWithScore.gameweekTotalPoints).toBe(54);

    mocks.findTeamScoreByTeamAndGameweek.mockResolvedValue(null);
    const { body: bodyWithoutScore } = await callGetLeagueTeamSquad(RIVAL_TEAM_ID);
    expect(bodyWithoutScore.gameweekTotalPoints).toBeNull();
  });

  it("mirrors getTeam's transfer-charge computation: one paid transfer costs 10 points and counts as 1", async () => {
    mocks.findCurrentGameweek.mockResolvedValue(
      buildGameweek({ id: GAMEWEEK_ID, number: 4, status: "IN_PROGRESS", deadlineAt: new Date("2026-08-20T11:30:00Z") }),
    );
    mocks.findTransfersByTeamAndGameweek.mockResolvedValue([transferCosting(0, "free"), transferCosting(10, "paid")]);

    const { body } = await callGetLeagueTeamSquad(RIVAL_TEAM_ID);

    expect(body.transferPointsCostThisGameweek).toBe(10);
    expect(body.paidTransferCountThisGameweek).toBe(1);
  });
});
