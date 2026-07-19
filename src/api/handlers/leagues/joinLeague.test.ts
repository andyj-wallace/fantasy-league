import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGameweek, buildLeague, buildTeam } from "../../../testing/fixtures";

const mocks = vi.hoisted(() => ({
  findByInviteCode: vi.fn(),
  countByLeagueId: vi.fn(),
  findCurrent: vi.fn(),
  insertIfAbsent: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  leaguesRepository: { findByInviteCode: mocks.findByInviteCode },
  teamsRepository: { countByLeagueId: mocks.countByLeagueId, insertIfAbsent: mocks.insertIfAbsent },
  gameweeksRepository: { findCurrent: mocks.findCurrent },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: "user1" }),
}));

import { joinLeague } from "./joinLeague";

async function callJoinLeague(body: unknown): Promise<{ statusCode: number; body: any }> {
  const result = (await joinLeague({
    httpMethod: "POST",
    path: "/leagues/join",
    pathParameters: null,
    queryStringParameters: null,
    headers: {},
    body: JSON.stringify(body),
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

describe("joinLeague", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countByLeagueId.mockResolvedValue(0);
    mocks.findCurrent.mockResolvedValue(null);
  });

  it("rejects when the league is already at the 50-manager cap", async () => {
    mocks.findByInviteCode.mockResolvedValue(buildLeague({ id: "league1" }));
    mocks.countByLeagueId.mockResolvedValue(50);

    const { statusCode, body } = await callJoinLeague({ inviteCode: "ABC123" });

    expect(statusCode).toBe(409);
    expect(body.message).toMatch(/full/i);
    expect(mocks.insertIfAbsent).not.toHaveBeenCalled();
  });

  it("rejects once the system-wide Gameweek 25 join cutoff has passed", async () => {
    mocks.findByInviteCode.mockResolvedValue(buildLeague({ id: "league1" }));
    mocks.findCurrent.mockResolvedValue(buildGameweek({ number: 25 }));

    const { statusCode, body } = await callJoinLeague({ inviteCode: "ABC123" });

    expect(statusCode).toBe(409);
    expect(body.message).toMatch(/Gameweek 25/);
    expect(mocks.insertIfAbsent).not.toHaveBeenCalled();
  });

  it("allows joining before Gameweek 25 with room in the league", async () => {
    const league = buildLeague({ id: "league1" });
    mocks.findByInviteCode.mockResolvedValue(league);
    mocks.findCurrent.mockResolvedValue(buildGameweek({ number: 10 }));
    mocks.insertIfAbsent.mockResolvedValue(buildTeam({ id: "team1", leagueId: "league1" }));

    const { statusCode, body } = await callJoinLeague({ inviteCode: "ABC123" });

    expect(statusCode).toBe(201);
    expect(body.team.id).toBe("team1");
  });

  it("returns 404 when the invite code doesn't match a league", async () => {
    mocks.findByInviteCode.mockResolvedValue(null);

    const { statusCode } = await callJoinLeague({ inviteCode: "NOPE" });

    expect(statusCode).toBe(404);
  });

  it("returns 409 when the caller already has a team in the league", async () => {
    mocks.findByInviteCode.mockResolvedValue(buildLeague({ id: "league1" }));
    mocks.insertIfAbsent.mockResolvedValue(null);

    const { statusCode, body } = await callJoinLeague({ inviteCode: "ABC123" });

    expect(statusCode).toBe(409);
    expect(body.message).toMatch(/already joined/i);
  });
});
