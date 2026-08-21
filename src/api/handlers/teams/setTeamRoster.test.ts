import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Player, TeamRosterSlot } from "../../../domain";
import { buildGameweek, buildMatch, buildPlayer, buildTeam } from "../../../testing/fixtures";

/**
 * Unit tests for setTeamRoster's partial-apply locking semantics (decided 2026-07-02): changes
 * touching a locked player are skipped (the locked player keeps their current slot) while the
 * rest of the save applies, each skip reported in lockedChangeWarnings; a save whose skips leave
 * the effective squad invalid is rejected with the locked adjustments named. Repositories and
 * requireAuth are mocked; locking itself runs the real isClubLocked against fixture matches.
 */
const USER_ID = "user1";
const TEAM_ID = "team1";
const GAMEWEEK_ID = "gw1";
const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);
const ONE_HOUR_FROM_NOW = new Date(Date.now() + 60 * 60 * 1000);

const mocks = vi.hoisted(() => ({
  findTeamById: vi.fn(),
  findRosterSlots: vi.fn(),
  replaceRosterSlots: vi.fn(),
  findFullTeamById: vi.fn(),
  findManyPlayersByIds: vi.fn(),
  findCurrentGameweek: vi.fn(),
  findMatchesByGameweekId: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  teamsRepository: {
    findById: mocks.findTeamById,
    findRosterSlots: mocks.findRosterSlots,
    replaceRosterSlots: mocks.replaceRosterSlots,
    findFullTeamById: mocks.findFullTeamById,
  },
  playersRepository: { findManyByIds: mocks.findManyPlayersByIds },
  gameweeksRepository: { findCurrent: mocks.findCurrentGameweek },
  matchesRepository: { findByGameweekId: mocks.findMatchesByGameweekId },
}));

vi.mock("../../auth", () => ({
  requireAuth:
    (handler: (event: unknown, session: { userId: string }) => Promise<unknown>) => (event: unknown) =>
      handler(event, { userId: USER_ID }),
}));

import { setTeamRoster } from "./setTeamRoster";

/**
 * A valid 16-man squad: 2 GK, 5 DEF, 5 MID, 4 FWD, every player at a distinct club (so locking
 * one club locks exactly one player). Starters form a 4-4-2: p01 GK; p03–p06 DEF; p08–p11 MID;
 * p13–p14 FWD. Bench: p02, p07, p12, p15, p16.
 */
function buildSixteenManSquad(): { playersById: Map<string, Player>; currentSlots: TeamRosterSlot[] } {
  const positionByPlayerId: Record<string, Player["position"]> = {
    p01: "GK", p02: "GK",
    p03: "DEF", p04: "DEF", p05: "DEF", p06: "DEF", p07: "DEF",
    p08: "MID", p09: "MID", p10: "MID", p11: "MID", p12: "MID",
    p13: "FWD", p14: "FWD", p15: "FWD", p16: "FWD",
  };
  const startingPlayerIds = new Set(["p01", "p03", "p04", "p05", "p06", "p08", "p09", "p10", "p11", "p13", "p14"]);

  const playersById = new Map<string, Player>();
  const currentSlots: TeamRosterSlot[] = [];
  for (const [playerId, position] of Object.entries(positionByPlayerId)) {
    playersById.set(playerId, buildPlayer({ id: playerId, name: `Player ${playerId}`, club: `Club ${playerId}`, position }));
    currentSlots.push({ playerId, isStarting: startingPlayerIds.has(playerId) });
  }
  return { playersById, currentSlots };
}

/** Replaces one player's isStarting in a slot list (pure — returns a new array). */
function withStartingStatus(slots: TeamRosterSlot[], playerId: string, isStarting: boolean): TeamRosterSlot[] {
  return slots.map((slot) => (slot.playerId === playerId ? { ...slot, isStarting } : slot));
}

function kickedOffMatchFor(club: string) {
  return buildMatch({ gameweekId: GAMEWEEK_ID, homeClub: club, awayClub: "Opponent FC", kickoffAt: ONE_HOUR_AGO, status: "IN_PROGRESS" });
}

async function callSetTeamRoster(rosterSlots: TeamRosterSlot[]): Promise<{ statusCode: number; body: any }> {
  const result = (await setTeamRoster({
    httpMethod: "PUT",
    path: `/teams/${TEAM_ID}/roster`,
    pathParameters: { teamId: TEAM_ID },
    queryStringParameters: null,
    headers: {},
    body: JSON.stringify({ rosterSlots }),
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

let squad: ReturnType<typeof buildSixteenManSquad>;

beforeEach(() => {
  vi.clearAllMocks();
  squad = buildSixteenManSquad();

  mocks.findTeamById.mockResolvedValue(buildTeam({ id: TEAM_ID, userId: USER_ID }));
  mocks.findRosterSlots.mockResolvedValue(squad.currentSlots);
  mocks.findManyPlayersByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => squad.playersById.get(id)).filter((player): player is Player => player !== undefined),
  );
  mocks.findCurrentGameweek.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, status: "IN_PROGRESS" }));
  mocks.findMatchesByGameweekId.mockResolvedValue([
    buildMatch({ gameweekId: GAMEWEEK_ID, homeClub: "Club p01", awayClub: "Club p03", kickoffAt: ONE_HOUR_FROM_NOW, status: "SCHEDULED" }),
  ]);
  mocks.findFullTeamById.mockResolvedValue(buildTeam({ id: TEAM_ID, userId: USER_ID }));
});

describe("setTeamRoster — partial apply for locked players", () => {
  it("keeps a locked player whose removal was attempted, applies the rest of the save, and warns", async () => {
    // p16 (bench FWD) is locked and removed from the submission; meanwhile an unlocked swap
    // (starter p13 -> bench, bench p15 -> starting) is also submitted and must still apply.
    mocks.findMatchesByGameweekId.mockResolvedValue([kickedOffMatchFor("Club p16")]);
    const submitted = withStartingStatus(withStartingStatus(squad.currentSlots, "p13", false), "p15", true).filter(
      (slot) => slot.playerId !== "p16",
    );

    const { statusCode, body } = await callSetTeamRoster(submitted);

    expect(statusCode).toBe(200);
    expect(body.lockedChangeWarnings).toEqual(["Player p16 is locked — kept in your squad"]);
    expect(mocks.replaceRosterSlots).toHaveBeenCalledTimes(1);
    const [, savedSlots] = mocks.replaceRosterSlots.mock.calls[0]! as [string, TeamRosterSlot[]];
    expect(savedSlots).toHaveLength(16);
    expect(savedSlots).toContainEqual({ playerId: "p16", isStarting: false });
    expect(savedSlots).toContainEqual({ playerId: "p13", isStarting: false });
    expect(savedSlots).toContainEqual({ playerId: "p15", isStarting: true });
  });

  it("rejects a save whose locked-player skips leave the squad invalid, naming the locked player", async () => {
    // Benching locked starter p14 while starting p15 reverts to 12 starters once p14 is kept.
    mocks.findMatchesByGameweekId.mockResolvedValue([kickedOffMatchFor("Club p14")]);
    const submitted = withStartingStatus(withStartingStatus(squad.currentSlots, "p14", false), "p15", true);

    const { statusCode, body } = await callSetTeamRoster(submitted);

    expect(statusCode).toBe(400);
    expect(body.message).toContain("Player p14 is locked — kept in the starting XI");
    expect(mocks.replaceRosterSlots).not.toHaveBeenCalled();
  });

  it("skips adding a locked player and rejects if that leaves the squad short, naming them", async () => {
    // p17 is a new locked signing replacing unlocked p15 — the addition is skipped, leaving 15.
    squad.playersById.set("p17", buildPlayer({ id: "p17", name: "Player p17", club: "Club p17", position: "FWD" }));
    mocks.findMatchesByGameweekId.mockResolvedValue([kickedOffMatchFor("Club p17")]);
    const submitted = squad.currentSlots
      .filter((slot) => slot.playerId !== "p15")
      .concat({ playerId: "p17", isStarting: false });

    const { statusCode, body } = await callSetTeamRoster(submitted);

    expect(statusCode).toBe(400);
    expect(body.message).toContain("Player p17 is locked — not added to your squad");
    expect(mocks.replaceRosterSlots).not.toHaveBeenCalled();
  });

  it("allows an idempotent re-save that leaves locked players unchanged, with no warnings", async () => {
    mocks.findMatchesByGameweekId.mockResolvedValue([kickedOffMatchFor("Club p14")]);

    const { statusCode, body } = await callSetTeamRoster(squad.currentSlots);

    expect(statusCode).toBe(200);
    expect(body.lockedChangeWarnings).toEqual([]);
    expect(mocks.replaceRosterSlots).toHaveBeenCalledTimes(1);
  });

  it("applies every change untouched when no match this gameweek has kicked off", async () => {
    const submitted = withStartingStatus(withStartingStatus(squad.currentSlots, "p14", false), "p15", true);

    const { statusCode, body } = await callSetTeamRoster(submitted);

    expect(statusCode).toBe(200);
    expect(body.lockedChangeWarnings).toEqual([]);
    const [, savedSlots] = mocks.replaceRosterSlots.mock.calls[0]! as [string, TeamRosterSlot[]];
    expect(savedSlots).toContainEqual({ playerId: "p14", isStarting: false });
    expect(savedSlots).toContainEqual({ playerId: "p15", isStarting: true });
  });

  it("still rejects a structurally invalid squad with no locks involved", async () => {
    const submitted = squad.currentSlots.filter((slot) => slot.playerId !== "p16");

    const { statusCode, body } = await callSetTeamRoster(submitted);

    expect(statusCode).toBe(400);
    expect(body.message).not.toContain("locked");
    expect(mocks.replaceRosterSlots).not.toHaveBeenCalled();
  });
});

/**
 * A roster save is the one write that can quietly invalidate captaincy: it can bench or drop
 * whoever wears the armband, and nothing else revisits the assignment. Left alone, the stored
 * captain would outlive their place in the XI and still collect the 2x when the gameweek scored.
 */
describe("setTeamRoster — captaincy the new roster invalidates", () => {
  function givenTeamWithCaptaincy(captainPlayerId: string | null, viceCaptainPlayerId: string | null) {
    mocks.findTeamById.mockResolvedValue(
      buildTeam({ id: TEAM_ID, userId: USER_ID, captainPlayerId, viceCaptainPlayerId }),
    );
  }

  it("clears the captain when the save benches them, and says so", async () => {
    givenTeamWithCaptaincy("p13", "p14");

    // Starter p13 (the captain) swaps to the bench; bench p15 comes in, keeping a valid 4-4-2.
    const submitted = withStartingStatus(withStartingStatus(squad.currentSlots, "p13", false), "p15", true);
    const { statusCode, body } = await callSetTeamRoster(submitted);

    expect(statusCode).toBe(200);
    expect(body.captaincyChangeWarnings).toEqual([
      "Player p13 is no longer in your starting XI — captain cleared, pick a new one",
    ]);
    expect(mocks.replaceRosterSlots).toHaveBeenCalledWith(
      TEAM_ID,
      expect.anything(),
      expect.any(Number),
      { clearCaptainPlayerId: true, clearViceCaptainPlayerId: false },
    );
  });

  it("clears the vice-captain independently of the captain", async () => {
    givenTeamWithCaptaincy("p14", "p13");

    const submitted = withStartingStatus(withStartingStatus(squad.currentSlots, "p13", false), "p15", true);
    const { statusCode, body } = await callSetTeamRoster(submitted);

    expect(statusCode).toBe(200);
    expect(body.captaincyChangeWarnings).toEqual([
      "Player p13 is no longer in your starting XI — vice-captain cleared, pick a new one",
    ]);
    expect(mocks.replaceRosterSlots).toHaveBeenCalledWith(
      TEAM_ID,
      expect.anything(),
      expect.any(Number),
      { clearCaptainPlayerId: false, clearViceCaptainPlayerId: true },
    );
  });

  it("leaves captaincy alone when both still start", async () => {
    givenTeamWithCaptaincy("p13", "p14");

    // A swap that touches neither of them: starter p11 down, bench p12 up (both MID).
    const submitted = withStartingStatus(withStartingStatus(squad.currentSlots, "p11", false), "p12", true);
    const { statusCode, body } = await callSetTeamRoster(submitted);

    expect(statusCode).toBe(200);
    expect(body.captaincyChangeWarnings).toEqual([]);
    expect(mocks.replaceRosterSlots).toHaveBeenCalledWith(
      TEAM_ID,
      expect.anything(),
      expect.any(Number),
      { clearCaptainPlayerId: false, clearViceCaptainPlayerId: false },
    );
  });

  it("clears nothing for a team that has never set a captain", async () => {
    givenTeamWithCaptaincy(null, null);

    const { statusCode, body } = await callSetTeamRoster(squad.currentSlots);

    expect(statusCode).toBe(200);
    expect(body.captaincyChangeWarnings).toEqual([]);
    expect(mocks.replaceRosterSlots).toHaveBeenCalledWith(
      TEAM_ID,
      expect.anything(),
      expect.any(Number),
      { clearCaptainPlayerId: false, clearViceCaptainPlayerId: false },
    );
  });
});
