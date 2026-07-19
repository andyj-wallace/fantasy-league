import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLeague } from "../../../testing/fixtures";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  leaguesRepository: { findById: mocks.findById, update: mocks.update },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: "commissioner1" }),
}));

import { updateLeague } from "./updateLeague";

async function callUpdateLeague(body: unknown): Promise<{ statusCode: number; body: any }> {
  const result = (await updateLeague({
    httpMethod: "PATCH",
    path: "/leagues/league1",
    pathParameters: { leagueId: "league1" },
    queryStringParameters: null,
    headers: {},
    body: JSON.stringify(body),
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

describe("updateLeague", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a rename while settings are locked", async () => {
    mocks.findById.mockResolvedValue(
      buildLeague({ id: "league1", commissionerUserId: "commissioner1", areSettingsLocked: true }),
    );

    const { statusCode, body } = await callUpdateLeague({ name: "New Name" });

    expect(statusCode).toBe(409);
    expect(body.message).toMatch(/locked/i);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("allows a rename while settings are unlocked", async () => {
    mocks.findById.mockResolvedValue(
      buildLeague({ id: "league1", commissionerUserId: "commissioner1", areSettingsLocked: false }),
    );
    mocks.update.mockResolvedValue(buildLeague({ id: "league1", name: "New Name" }));

    const { statusCode } = await callUpdateLeague({ name: "New Name" });

    expect(statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("league1", { name: "New Name" });
  });

  it("always allows toggling the lock itself, even while locked", async () => {
    mocks.findById.mockResolvedValue(
      buildLeague({ id: "league1", commissionerUserId: "commissioner1", areSettingsLocked: true }),
    );
    mocks.update.mockResolvedValue(buildLeague({ id: "league1", areSettingsLocked: false }));

    const { statusCode } = await callUpdateLeague({ areSettingsLocked: false });

    expect(statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("league1", { areSettingsLocked: false });
  });

  it("returns 403 when the caller isn't the commissioner", async () => {
    mocks.findById.mockResolvedValue(buildLeague({ id: "league1", commissionerUserId: "someoneElse" }));

    const { statusCode } = await callUpdateLeague({ name: "New Name" });

    expect(statusCode).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("returns 404 when the league doesn't exist", async () => {
    mocks.findById.mockResolvedValue(null);

    const { statusCode } = await callUpdateLeague({ name: "New Name" });

    expect(statusCode).toBe(404);
  });
});
