import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Player, Team, TeamRosterSlot } from "../../../domain";
import { buildGameweek, buildMatch, buildPlayer, buildTeam } from "../../../testing/fixtures";

/**
 * Unit tests for setTeamLineup's partial-apply locking semantics (decided 2026-07-02): a
 * captain/vice-captain change onto a locked player is skipped (the current assignment is kept)
 * while the rest of the save applies, reported in lockedChangeWarnings — unless the skips would
 * leave captain and vice-captain as the same player, which rejects the save instead.
 */
const USER_ID = "user1";
const TEAM_ID = "team1";
const GAMEWEEK_ID = "gw1";
const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);

const mocks = vi.hoisted(() => ({
  findTeamById: vi.fn(),
  findRosterSlots: vi.fn(),
  updateLineup: vi.fn(),
  findFullTeamById: vi.fn(),
  findManyPlayersByIds: vi.fn(),
  findCurrentGameweek: vi.fn(),
  findMatchesByGameweekId: vi.fn(),
}));

vi.mock("../../../db/repositories", () => ({
  teamsRepository: {
    findById: mocks.findTeamById,
    findRosterSlots: mocks.findRosterSlots,
    updateLineup: mocks.updateLineup,
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

import { setTeamLineup } from "./setTeamLineup";

/** Same 4-4-2 squad shape as the setTeamRoster tests; see buildSixteenManSquad there. */
const POSITION_BY_PLAYER_ID: Record<string, Player["position"]> = {
  p01: "GK", p02: "GK",
  p03: "DEF", p04: "DEF", p05: "DEF", p06: "DEF", p07: "DEF",
  p08: "MID", p09: "MID", p10: "MID", p11: "MID", p12: "MID",
  p13: "FWD", p14: "FWD", p15: "FWD", p16: "FWD",
};
const STARTING_PLAYER_IDS = new Set(["p01", "p03", "p04", "p05", "p06", "p08", "p09", "p10", "p11", "p13", "p14"]);
const FORMATION = "4-4-2";

function kickedOffMatchFor(club: string) {
  return buildMatch({ gameweekId: GAMEWEEK_ID, homeClub: club, awayClub: "Opponent FC", kickoffAt: ONE_HOUR_AGO, status: "IN_PROGRESS" });
}

async function callSetTeamLineup(lineup: {
  formation?: string;
  captainPlayerId: string;
  viceCaptainPlayerId: string;
}): Promise<{ statusCode: number; body: any }> {
  const result = (await setTeamLineup({
    httpMethod: "PUT",
    path: `/teams/${TEAM_ID}/lineup`,
    pathParameters: { teamId: TEAM_ID },
    queryStringParameters: null,
    headers: {},
    body: JSON.stringify({ formation: FORMATION, ...lineup }),
  })) as { statusCode: number; body: string };
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

function givenTeamWithCaptaincy(captainPlayerId: string | null, viceCaptainPlayerId: string | null): Team {
  const team = buildTeam({ id: TEAM_ID, userId: USER_ID, formation: FORMATION, captainPlayerId, viceCaptainPlayerId });
  mocks.findTeamById.mockResolvedValue(team);
  return team;
}

beforeEach(() => {
  vi.clearAllMocks();

  const players = Object.entries(POSITION_BY_PLAYER_ID).map(([playerId, position]) =>
    buildPlayer({ id: playerId, name: `Player ${playerId}`, club: `Club ${playerId}`, position }),
  );
  const rosterSlots: TeamRosterSlot[] = players.map((player) => ({
    playerId: player.id,
    isStarting: STARTING_PLAYER_IDS.has(player.id),
  }));

  mocks.findRosterSlots.mockResolvedValue(rosterSlots);
  mocks.findManyPlayersByIds.mockResolvedValue(players);
  mocks.findCurrentGameweek.mockResolvedValue(buildGameweek({ id: GAMEWEEK_ID, status: "IN_PROGRESS" }));
  mocks.findMatchesByGameweekId.mockResolvedValue([kickedOffMatchFor("Club p14")]);
  mocks.findFullTeamById.mockResolvedValue(buildTeam({ id: TEAM_ID, userId: USER_ID }));
});

describe("setTeamLineup — partial apply for locked players", () => {
  it("keeps the current captain when the new captain is locked, applies the vice-captain change, and warns", async () => {
    givenTeamWithCaptaincy("p01", "p03");

    const { statusCode, body } = await callSetTeamLineup({ captainPlayerId: "p14", viceCaptainPlayerId: "p04" });

    expect(statusCode).toBe(200);
    expect(body.lockedChangeWarnings).toEqual(["Player p14 is locked — captain unchanged"]);
    expect(mocks.updateLineup).toHaveBeenCalledWith(TEAM_ID, {
      formation: FORMATION,
      captainPlayerId: "p01",
      viceCaptainPlayerId: "p04",
    });
  });

  it("rejects a captain/vice swap that would collide after skipping the locked side", async () => {
    // Captain p01 -> locked p14 is skipped (captain stays p01); vice p14 -> p01 would apply,
    // leaving p01 as both. Nothing must be saved.
    givenTeamWithCaptaincy("p01", "p14");

    const { statusCode, body } = await callSetTeamLineup({ captainPlayerId: "p14", viceCaptainPlayerId: "p01" });

    expect(statusCode).toBe(400);
    expect(body.message).toContain("captain and vice-captain must be different players");
    expect(body.message).toContain("Player p14 is locked");
    expect(mocks.updateLineup).not.toHaveBeenCalled();
  });

  it("rejects assigning a locked captain when there is no current captain to keep", async () => {
    givenTeamWithCaptaincy(null, null);

    const { statusCode, body } = await callSetTeamLineup({ captainPlayerId: "p14", viceCaptainPlayerId: "p04" });

    expect(statusCode).toBe(400);
    expect(body.message).toContain("no current captain to keep");
    expect(mocks.updateLineup).not.toHaveBeenCalled();
  });

  it("allows an idempotent re-save of a locked captain, with no warnings", async () => {
    givenTeamWithCaptaincy("p14", "p03");

    const { statusCode, body } = await callSetTeamLineup({ captainPlayerId: "p14", viceCaptainPlayerId: "p03" });

    expect(statusCode).toBe(200);
    expect(body.lockedChangeWarnings).toEqual([]);
    expect(mocks.updateLineup).toHaveBeenCalledWith(TEAM_ID, {
      formation: FORMATION,
      captainPlayerId: "p14",
      viceCaptainPlayerId: "p03",
    });
  });

  it("rejects captain === vice-captain even with no locks involved", async () => {
    givenTeamWithCaptaincy("p01", "p03");
    mocks.findMatchesByGameweekId.mockResolvedValue([]);

    const { statusCode, body } = await callSetTeamLineup({ captainPlayerId: "p04", viceCaptainPlayerId: "p04" });

    expect(statusCode).toBe(400);
    expect(body.message).toContain("captain and vice-captain must be different players");
    expect(mocks.updateLineup).not.toHaveBeenCalled();
  });
});

/**
 * Only a starter can wear the armband. calculateTeamScores applies the 2x by player id alone, so
 * a benched captain that reached the database would double a bench player's points — and V1 adds
 * bench points to the team total regardless, so nothing downstream would catch it.
 */
describe("setTeamLineup — captain and vice-captain must be in the starting XI", () => {
  it("rejects a captain who is on the bench", async () => {
    givenTeamWithCaptaincy("p01", "p03");

    // p15 is a bench FWD at an unlocked club, so nothing but the starter rule can stop it.
    const { statusCode, body } = await callSetTeamLineup({ captainPlayerId: "p15", viceCaptainPlayerId: "p03" });

    expect(statusCode).toBe(400);
    expect(body.message).toBe("Player p15 is on the bench — your captain must be in the starting XI");
    expect(mocks.updateLineup).not.toHaveBeenCalled();
  });

  it("rejects a vice-captain who is on the bench", async () => {
    givenTeamWithCaptaincy("p01", "p03");

    const { statusCode, body } = await callSetTeamLineup({ captainPlayerId: "p01", viceCaptainPlayerId: "p12" });

    expect(statusCode).toBe(400);
    expect(body.message).toBe("Player p12 is on the bench — your vice-captain must be in the starting XI");
    expect(mocks.updateLineup).not.toHaveBeenCalled();
  });

  it("rejects a benched captain that a locked-player skip would have reinstated", async () => {
    // The stored captain p15 is already on the bench. Moving the armband to locked p14 is skipped,
    // which would ordinarily keep p15 — so the skip must not smuggle a bench player back in.
    givenTeamWithCaptaincy("p15", "p03");

    const { statusCode, body } = await callSetTeamLineup({ captainPlayerId: "p14", viceCaptainPlayerId: "p03" });

    expect(statusCode).toBe(400);
    expect(body.message).toContain("Player p15 is on the bench — your captain must be in the starting XI");
    expect(body.message).toContain("after skipping locked-player changes");
    expect(mocks.updateLineup).not.toHaveBeenCalled();
  });

  it("still saves when both captain and vice-captain are starters", async () => {
    givenTeamWithCaptaincy("p01", "p03");

    const { statusCode } = await callSetTeamLineup({ captainPlayerId: "p04", viceCaptainPlayerId: "p03" });

    expect(statusCode).toBe(200);
    expect(mocks.updateLineup).toHaveBeenCalledWith(TEAM_ID, {
      formation: FORMATION,
      captainPlayerId: "p04",
      viceCaptainPlayerId: "p03",
    });
  });
});
