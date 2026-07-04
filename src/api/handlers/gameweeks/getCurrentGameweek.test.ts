import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGameweek, buildMatch } from "../../../testing/fixtures";

const mocks = vi.hoisted(() => ({
  findCurrentGameweek: vi.fn(),
  findMatchesByGameweekId: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  gameweeksRepository: { findCurrent: mocks.findCurrentGameweek },
  matchesRepository: { findByGameweekId: mocks.findMatchesByGameweekId },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: "user1" }),
}));

import { getCurrentGameweek } from "./getCurrentGameweek";

async function callGetCurrentGameweek(): Promise<{ statusCode: number; body: any }> {
  const result = (await getCurrentGameweek({
    httpMethod: "GET",
    path: "/gameweeks/current",
    pathParameters: null,
    queryStringParameters: null,
    headers: {},
    body: null,
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

describe("getCurrentGameweek", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a null gameweek and no matches before any gameweek exists", async () => {
    mocks.findCurrentGameweek.mockResolvedValue(null);

    const { statusCode, body } = await callGetCurrentGameweek();

    expect(statusCode).toBe(200);
    expect(body).toEqual({ gameweek: null, matches: [] });
    expect(mocks.findMatchesByGameweekId).not.toHaveBeenCalled();
  });

  it("returns the current gameweek's number, status, deadline, and its matches sorted by kickoff", async () => {
    const gameweek = buildGameweek({
      id: "gw4",
      number: 4,
      status: "UPCOMING",
      deadlineAt: new Date("2026-07-22T11:30:00Z"),
    });
    mocks.findCurrentGameweek.mockResolvedValue(gameweek);
    const laterMatch = buildMatch({
      id: "match-later",
      gameweekId: "gw4",
      homeClub: "Arsenal",
      awayClub: "Chelsea",
      kickoffAt: new Date("2026-07-26T15:00:00Z"),
      status: "SCHEDULED",
      finalHomeScore: null,
      finalAwayScore: null,
    });
    const earlierMatch = buildMatch({
      id: "match-earlier",
      gameweekId: "gw4",
      homeClub: "Liverpool",
      awayClub: "Everton",
      kickoffAt: new Date("2026-07-25T14:00:00Z"),
      status: "SCHEDULED",
      finalHomeScore: null,
      finalAwayScore: null,
    });
    mocks.findMatchesByGameweekId.mockResolvedValue([laterMatch, earlierMatch]);

    const { statusCode, body } = await callGetCurrentGameweek();

    expect(statusCode).toBe(200);
    expect(body.gameweek).toEqual({
      id: "gw4",
      number: 4,
      status: "UPCOMING",
      deadlineAt: "2026-07-22T11:30:00.000Z",
    });
    expect(body.matches.map((match: { id: string }) => match.id)).toEqual(["match-earlier", "match-later"]);
    expect(body.matches[0]).toEqual({
      id: "match-earlier",
      homeClub: "Liverpool",
      awayClub: "Everton",
      kickoffAt: "2026-07-25T14:00:00.000Z",
      status: "SCHEDULED",
      finalHomeScore: null,
      finalAwayScore: null,
    });
    expect(mocks.findMatchesByGameweekId).toHaveBeenCalledWith("gw4");
  });
});
