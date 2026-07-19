import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLeague, buildTeam } from "../../../testing/fixtures";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findByLeagueId: vi.fn(),
  findManyByIds: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  leaguesRepository: { findById: mocks.findById },
  teamsRepository: { findByLeagueId: mocks.findByLeagueId },
  usersRepository: { findManyByIds: mocks.findManyByIds },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: "commissioner1" }),
}));

import { getLeagueMembers } from "./getLeagueMembers";

async function callGetLeagueMembers(): Promise<{ statusCode: number; body: any }> {
  const result = (await getLeagueMembers({
    httpMethod: "GET",
    path: "/leagues/league1/members",
    pathParameters: { leagueId: "league1" },
    queryStringParameters: null,
    headers: {},
    body: null,
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

describe("getLeagueMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists every member with their team and flags the commissioner", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "commissioner1" }));
    mocks.findByLeagueId.mockResolvedValue([
      buildTeam({ id: "team1", leagueId: "league1", userId: "commissioner1", name: "Commish FC" }),
      buildTeam({ id: "team2", leagueId: "league1", userId: "manager2", name: "Challenger FC" }),
    ]);
    mocks.findManyByIds.mockResolvedValue([
      { id: "commissioner1", displayName: "Alice", email: "a@example.com", cognitoSub: null, handle: null, createdAt: new Date() },
      { id: "manager2", displayName: "Bob", email: "b@example.com", cognitoSub: null, handle: null, createdAt: new Date() },
    ]);

    const { statusCode, body } = await callGetLeagueMembers();

    expect(statusCode).toBe(200);
    expect(body.members).toEqual([
      { userId: "commissioner1", displayName: "Alice", teamId: "team1", teamName: "Commish FC", isCommissioner: true },
      { userId: "manager2", displayName: "Bob", teamId: "team2", teamName: "Challenger FC", isCommissioner: false },
    ]);
  });

  it("returns 404 when the league doesn't exist", async () => {
    mocks.findById.mockResolvedValue(null);

    const { statusCode } = await callGetLeagueMembers();

    expect(statusCode).toBe(404);
  });
});
