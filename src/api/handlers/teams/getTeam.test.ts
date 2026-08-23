import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transfer } from "../../../domain";
import { buildGameweek, buildTeam } from "../../../testing/fixtures";

/**
 * Covers the paid-transfer figures the squad builder reads alongside the team itself:
 * transferPointsCostThisGameweek (a positive magnitude) and paidTransferCountThisGameweek. They
 * let the screen show the deduction calculateTeamScores will apply, rather than leaving the
 * manager to discover it as a gap in the standings.
 */
const USER_ID = "user1";
const TEAM_ID = "team1";
const GAMEWEEK_ID = "gw4";

const mocks = vi.hoisted(() => ({
  findFullTeamById: vi.fn(),
  findCurrentGameweek: vi.fn(),
  findTransfersByTeamAndGameweek: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  teamsRepository: { findFullTeamById: mocks.findFullTeamById },
  gameweeksRepository: { findCurrent: mocks.findCurrentGameweek },
  transfersRepository: { findByTeamAndGameweek: mocks.findTransfersByTeamAndGameweek },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: USER_ID }),
}));

import { getTeam } from "./getTeam";

function transferCosting(pointsCost: number, id: string): Transfer {
  return {
    id,
    teamId: TEAM_ID,
    gameweekId: GAMEWEEK_ID,
    playerOutId: `${id}-out`,
    playerInId: `${id}-in`,
    pointsCost,
    createdAt: new Date("2026-08-20T10:00:00Z"),
  };
}

async function callGetTeam(): Promise<{ statusCode: number; body: any }> {
  const result = (await getTeam({
    httpMethod: "GET",
    path: `/teams/${TEAM_ID}`,
    pathParameters: { teamId: TEAM_ID },
    queryStringParameters: null,
    headers: {},
    body: null,
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

describe("getTeam — this gameweek's transfer cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFullTeamById.mockResolvedValue(buildTeam({ id: TEAM_ID, userId: USER_ID }));
    mocks.findCurrentGameweek.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, number: 4 }));
    mocks.findTransfersByTeamAndGameweek.mockResolvedValue([]);
  });

  it("reports zero cost and zero paid transfers when none were made", async () => {
    const { statusCode, body } = await callGetTeam();

    expect(statusCode).toBe(200);
    expect(body.id).toBe(TEAM_ID);
    expect(body.transferPointsCostThisGameweek).toBe(0);
    expect(body.paidTransferCountThisGameweek).toBe(0);
  });

  it("sums the cost of paid transfers and counts only those that were charged for", async () => {
    mocks.findTransfersByTeamAndGameweek.mockResolvedValue([
      transferCosting(0, "free"),
      transferCosting(10, "paid1"),
      transferCosting(10, "paid2"),
    ]);

    const { body } = await callGetTeam();

    expect(body.transferPointsCostThisGameweek).toBe(20);
    expect(body.paidTransferCountThisGameweek).toBe(2);
  });

  it("ignores free transfers entirely", async () => {
    mocks.findTransfersByTeamAndGameweek.mockResolvedValue([transferCosting(0, "free1"), transferCosting(0, "free2")]);

    const { body } = await callGetTeam();

    expect(body.transferPointsCostThisGameweek).toBe(0);
    expect(body.paidTransferCountThisGameweek).toBe(0);
  });

  it("reports zero without querying transfers when no gameweek is open", async () => {
    mocks.findCurrentGameweek.mockResolvedValue(null);

    const { body } = await callGetTeam();

    expect(body.transferPointsCostThisGameweek).toBe(0);
    expect(body.paidTransferCountThisGameweek).toBe(0);
    expect(mocks.findTransfersByTeamAndGameweek).not.toHaveBeenCalled();
  });

  it("404s an unknown team without looking up its transfers", async () => {
    mocks.findFullTeamById.mockResolvedValue(null);

    const { statusCode } = await callGetTeam();

    expect(statusCode).toBe(404);
    expect(mocks.findTransfersByTeamAndGameweek).not.toHaveBeenCalled();
  });
});
