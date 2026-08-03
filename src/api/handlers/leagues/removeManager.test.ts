import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLeague, buildTeam } from "../../../testing/fixtures";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findByLeagueAndUser: vi.fn(),
  markRemoved: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  leaguesRepository: { findById: mocks.findById },
  teamsRepository: { findByLeagueAndUser: mocks.findByLeagueAndUser, markRemoved: mocks.markRemoved },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: "commissioner1" }),
}));

import { removeManager } from "./removeManager";

async function callRemoveManager(userId: string): Promise<{ statusCode: number; body: unknown }> {
  const result = (await removeManager({
    httpMethod: "DELETE",
    path: `/leagues/league1/managers/${userId}`,
    pathParameters: { leagueId: "league1", userId },
    queryStringParameters: null,
    headers: {},
    body: null,
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
}

describe("removeManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects the commissioner removing themselves", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "commissioner1" }));

    const { statusCode, body } = await callRemoveManager("commissioner1");

    expect(statusCode).toBe(403);
    expect((body as { message: string }).message).toMatch(/cannot remove themselves/i);
    expect(mocks.markRemoved).not.toHaveBeenCalled();
  });

  it("soft-removes a manager's team", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "commissioner1" }));
    mocks.findByLeagueAndUser.mockResolvedValue(buildTeam({ id: "team2", leagueId: "league1", userId: "manager2" }));

    const { statusCode } = await callRemoveManager("manager2");

    expect(statusCode).toBe(204);
    expect(mocks.markRemoved).toHaveBeenCalledWith("team2");
  });

  it("returns 403 when the caller isn't the commissioner", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "someoneElse" }));

    const { statusCode } = await callRemoveManager("manager2");

    expect(statusCode).toBe(403);
    expect(mocks.markRemoved).not.toHaveBeenCalled();
  });

  it("returns 404 when the target manager has no team in the league", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "commissioner1" }));
    mocks.findByLeagueAndUser.mockResolvedValue(null);

    const { statusCode } = await callRemoveManager("manager2");

    expect(statusCode).toBe(404);
  });
});
