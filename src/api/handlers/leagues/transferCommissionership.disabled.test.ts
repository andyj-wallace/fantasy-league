import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findByLeagueAndUser: vi.fn(),
  transferCommissionership: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  leaguesRepository: { findById: mocks.findById, transferCommissionership: mocks.transferCommissionership },
  teamsRepository: { findByLeagueAndUser: mocks.findByLeagueAndUser },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: "commissioner1" }),
}));

import { transferCommissionership } from "./transferCommissionership";

describe("transferCommissionership (real IS_COMMISSIONERSHIP_TRANSFER_ENABLED default)", () => {
  it("returns 403 without touching any repository, since the feature defaults to disabled", async () => {
    const result = (await transferCommissionership({
      httpMethod: "POST",
      path: "/leagues/league1/transfer-commissionership",
      pathParameters: { leagueId: "league1" },
      queryStringParameters: null,
      headers: {},
      body: JSON.stringify({ newCommissionerUserId: "manager2" }),
    })) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).message).toMatch(/not available/i);
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.transferCommissionership).not.toHaveBeenCalled();
  });
});
