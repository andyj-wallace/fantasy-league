import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Player, TeamRosterSlot } from "../../../domain";
import { buildGameweek, buildMatch, buildPlayer, buildTeam } from "../../../testing/fixtures";

/**
 * Unit tests for the captaincy consequence of a transfer. Transferring out the player wearing the
 * armband is the sharpest version of a stale-captaincy bug: they are not benched, they are gone
 * from the squad entirely, and calculateTeamScores applies the 2x by player id alone. Nothing
 * follows a transfer the way a lineup save follows a roster save, so the clear has to happen here.
 */
const USER_ID = "user1";
const TEAM_ID = "team1";
const GAMEWEEK_ID = "gw1";
const ONE_HOUR_FROM_NOW = new Date(Date.now() + 60 * 60 * 1000);

const mocks = vi.hoisted(() => ({
  findTeamById: vi.fn(),
  findByIdForUpdate: vi.fn(),
  findRosterSlots: vi.fn(),
  replaceRosterSlots: vi.fn(),
  updateAfterTransfer: vi.fn(),
  findPlayerById: vi.fn(),
  findManyPlayersByIds: vi.fn(),
  findCurrentGameweek: vi.fn(),
  findMatchesByGameweekId: vi.fn(),
  insertTransfer: vi.fn(),
}));

// The transaction callback only ever hands its client to mocked repositories, so a bare object is
// a faithful stand-in for the real tx here.
vi.mock("../../../db/client", () => ({
  db: { transaction: async (run: (tx: unknown) => Promise<unknown>) => run({ tx: true }) },
}));

vi.mock("../../../db/repositories", () => ({
  teamsRepository: {
    findById: mocks.findTeamById,
    findByIdForUpdate: mocks.findByIdForUpdate,
    findRosterSlots: mocks.findRosterSlots,
    replaceRosterSlots: mocks.replaceRosterSlots,
    updateAfterTransfer: mocks.updateAfterTransfer,
  },
  playersRepository: { findById: mocks.findPlayerById, findManyByIds: mocks.findManyPlayersByIds },
  gameweeksRepository: { findCurrent: mocks.findCurrentGameweek },
  matchesRepository: { findByGameweekId: mocks.findMatchesByGameweekId },
  transfersRepository: { insert: mocks.insertTransfer },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: USER_ID }),
}));

import { makeTransfer } from "./makeTransfer";

/** Same 4-4-2 shape the setTeamRoster tests use, plus p17 as the unowned incoming FWD. */
const POSITION_BY_PLAYER_ID: Record<string, Player["position"]> = {
  p01: "GK", p02: "GK",
  p03: "DEF", p04: "DEF", p05: "DEF", p06: "DEF", p07: "DEF",
  p08: "MID", p09: "MID", p10: "MID", p11: "MID", p12: "MID",
  p13: "FWD", p14: "FWD", p15: "FWD", p16: "FWD", p17: "FWD",
};
const STARTING_PLAYER_IDS = new Set(["p01", "p03", "p04", "p05", "p06", "p08", "p09", "p10", "p11", "p13", "p14"]);

const playersById = new Map(
  Object.entries(POSITION_BY_PLAYER_ID).map(([playerId, position]) => [
    playerId,
    buildPlayer({ id: playerId, name: `Player ${playerId}`, club: `Club ${playerId}`, position, priceInMillions: 5 }),
  ]),
);

async function callMakeTransfer(playerOutId: string, playerInId: string): Promise<{ statusCode: number; body: any }> {
  const result = (await makeTransfer({
    httpMethod: "POST",
    path: `/teams/${TEAM_ID}/transfers`,
    pathParameters: { teamId: TEAM_ID },
    queryStringParameters: null,
    headers: {},
    body: JSON.stringify({ playerOutId, playerInId }),
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

function givenTeamWithCaptaincy(captainPlayerId: string | null, viceCaptainPlayerId: string | null) {
  const team = buildTeam({
    id: TEAM_ID,
    userId: USER_ID,
    captainPlayerId,
    viceCaptainPlayerId,
    remainingBudgetInMillions: 20,
    bankedFreeTransferCount: 2,
  });
  mocks.findTeamById.mockResolvedValue(team);
  mocks.findByIdForUpdate.mockResolvedValue(team);
}

beforeEach(() => {
  vi.clearAllMocks();

  const rosterSlots: TeamRosterSlot[] = Object.keys(POSITION_BY_PLAYER_ID)
    .filter((playerId) => playerId !== "p17")
    .map((playerId) => ({ playerId, isStarting: STARTING_PLAYER_IDS.has(playerId) }));

  givenTeamWithCaptaincy(null, null);
  mocks.findRosterSlots.mockResolvedValue(rosterSlots);
  mocks.findPlayerById.mockImplementation(async (id: string) => playersById.get(id) ?? null);
  mocks.findManyPlayersByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => playersById.get(id)).filter((player): player is Player => player !== undefined),
  );
  mocks.findCurrentGameweek.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, status: "UPCOMING" }));
  mocks.findMatchesByGameweekId.mockResolvedValue([
    buildMatch({ gameweekId: GAMEWEEK_ID, homeClub: "Club p01", awayClub: "Club p03", kickoffAt: ONE_HOUR_FROM_NOW, status: "SCHEDULED" }),
  ]);
});

describe("makeTransfer — captaincy the transfer invalidates", () => {
  it("clears the captain when they are the player transferred out, and says so", async () => {
    givenTeamWithCaptaincy("p13", "p14");

    const { statusCode, body } = await callMakeTransfer("p13", "p17");

    expect(statusCode).toBe(201);
    expect(body.captaincyChangeWarnings).toEqual([
      "Player p13 was your captain — captain cleared, pick a new one before the deadline",
    ]);
    expect(mocks.replaceRosterSlots).toHaveBeenCalledWith(
      TEAM_ID,
      expect.anything(),
      expect.any(Number),
      expect.objectContaining({ clearCaptainPlayerId: true, clearViceCaptainPlayerId: false }),
    );
  });

  it("clears the vice-captain when they are the player transferred out", async () => {
    givenTeamWithCaptaincy("p14", "p13");

    const { statusCode, body } = await callMakeTransfer("p13", "p17");

    expect(statusCode).toBe(201);
    expect(body.captaincyChangeWarnings).toEqual([
      "Player p13 was your vice-captain — vice-captain cleared, pick a new one before the deadline",
    ]);
    expect(mocks.replaceRosterSlots).toHaveBeenCalledWith(
      TEAM_ID,
      expect.anything(),
      expect.any(Number),
      expect.objectContaining({ clearCaptainPlayerId: false, clearViceCaptainPlayerId: true }),
    );
  });

  it("leaves captaincy alone when the transfer touches neither role", async () => {
    givenTeamWithCaptaincy("p13", "p14");

    // p16 is an unowned-by-either-role bench FWD; swapping him changes nothing about the armband.
    const { statusCode, body } = await callMakeTransfer("p16", "p17");

    expect(statusCode).toBe(201);
    expect(body.captaincyChangeWarnings).toEqual([]);
    expect(mocks.replaceRosterSlots).toHaveBeenCalledWith(
      TEAM_ID,
      expect.anything(),
      expect.any(Number),
      expect.objectContaining({ clearCaptainPlayerId: false, clearViceCaptainPlayerId: false }),
    );
  });
});
