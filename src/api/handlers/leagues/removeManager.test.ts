import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGameweek, buildLeague, buildTeam } from "../../../testing/fixtures";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findByLeagueAndUser: vi.fn(),
  deleteById: vi.fn(),
  findCurrent: vi.fn(),
  updateStandings: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  leaguesRepository: { findById: mocks.findById },
  teamsRepository: { findByLeagueAndUser: mocks.findByLeagueAndUser, deleteById: mocks.deleteById },
  gameweeksRepository: { findCurrent: mocks.findCurrent },
}));

vi.mock("../../../workers/updateStandings", () => ({
  updateStandings: mocks.updateStandings,
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
    expect(mocks.deleteById).not.toHaveBeenCalled();
  });

  it("removes a manager's team and recomputes standings for the current gameweek", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "commissioner1" }));
    mocks.findByLeagueAndUser.mockResolvedValue(buildTeam({ id: "team2", leagueId: "league1", userId: "manager2" }));
    const currentGameweek = buildGameweek({ id: "gw5" });
    mocks.findCurrent.mockResolvedValue(currentGameweek);

    const { statusCode } = await callRemoveManager("manager2");

    expect(statusCode).toBe(204);
    expect(mocks.deleteById).toHaveBeenCalledWith("team2");
    expect(mocks.updateStandings).toHaveBeenCalledWith("league1", "gw5");
  });

  it("skips the standings recompute when there's no current gameweek yet", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "commissioner1" }));
    mocks.findByLeagueAndUser.mockResolvedValue(buildTeam({ id: "team2", leagueId: "league1", userId: "manager2" }));
    mocks.findCurrent.mockResolvedValue(null);

    const { statusCode } = await callRemoveManager("manager2");

    expect(statusCode).toBe(204);
    expect(mocks.updateStandings).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller isn't the commissioner", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "someoneElse" }));

    const { statusCode } = await callRemoveManager("manager2");

    expect(statusCode).toBe(403);
    expect(mocks.deleteById).not.toHaveBeenCalled();
  });

  it("returns 404 when the target manager has no team in the league", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "commissioner1" }));
    mocks.findByLeagueAndUser.mockResolvedValue(null);

    const { statusCode } = await callRemoveManager("manager2");

    expect(statusCode).toBe(404);
  });
});
