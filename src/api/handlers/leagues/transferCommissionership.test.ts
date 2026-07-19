import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLeague, buildTeam } from "../../../testing/fixtures";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findByLeagueAndUser: vi.fn(),
  transferCommissionership: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  leaguesRepository: { findById: mocks.findById, transferCommissionership: mocks.transferCommissionership },
  teamsRepository: { findByLeagueAndUser: mocks.findByLeagueAndUser },
}));

// This file tests the handler's business logic, which only runs when the feature is on.
// The real IS_COMMISSIONERSHIP_TRANSFER_ENABLED default (false) is covered separately in
// transferCommissionership.disabled.test.ts.
vi.mock("../../../domain", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  IS_COMMISSIONERSHIP_TRANSFER_ENABLED: true,
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: "commissioner1" }),
}));

import { transferCommissionership } from "./transferCommissionership";

async function callTransferCommissionership(body: unknown): Promise<{ statusCode: number; body: any }> {
  const result = (await transferCommissionership({
    httpMethod: "POST",
    path: "/leagues/league1/transfer-commissionership",
    pathParameters: { leagueId: "league1" },
    queryStringParameters: null,
    headers: {},
    body: JSON.stringify(body),
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

describe("transferCommissionership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transfers commissionership to a league member", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "commissioner1" }));
    mocks.findByLeagueAndUser.mockResolvedValue(buildTeam({ id: "team2", leagueId: "league1", userId: "manager2" }));
    mocks.transferCommissionership.mockResolvedValue(
      buildLeague({ id: "league1", commissionerUserId: "manager2" }),
    );

    const { statusCode, body } = await callTransferCommissionership({ newCommissionerUserId: "manager2" });

    expect(statusCode).toBe(200);
    expect(body.commissionerUserId).toBe("manager2");
    expect(mocks.transferCommissionership).toHaveBeenCalledWith("league1", "manager2");
  });

  it("returns 400 when the target isn't a member of the league", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "commissioner1" }));
    mocks.findByLeagueAndUser.mockResolvedValue(null);

    const { statusCode, body } = await callTransferCommissionership({ newCommissionerUserId: "notAMember" });

    expect(statusCode).toBe(400);
    expect(body.message).toMatch(/member of this league/i);
    expect(mocks.transferCommissionership).not.toHaveBeenCalled();
  });

  it("returns 400 when newCommissionerUserId is missing", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "commissioner1" }));

    const { statusCode } = await callTransferCommissionership({});

    expect(statusCode).toBe(400);
  });

  it("returns 403 when the caller isn't the commissioner", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "someoneElse" }));

    const { statusCode } = await callTransferCommissionership({ newCommissionerUserId: "manager2" });

    expect(statusCode).toBe(403);
  });

  it("returns 404 when the league doesn't exist", async () => {
    mocks.findById.mockResolvedValue(null);

    const { statusCode } = await callTransferCommissionership({ newCommissionerUserId: "manager2" });

    expect(statusCode).toBe(404);
  });
});
