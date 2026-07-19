import { randomUUID } from "node:crypto";
import type {
  Gameweek,
  League,
  Match,
  Player,
  PlayerMatchStat,
  PlayerPosition,
  Team,
  TeamRosterSlot,
} from "../domain";

/**
 * Fully-typed, override-friendly builders for the scoring engine's domain inputs. Every field has
 * a sensible default so a test only spells out the fields it actually cares about (e.g. a goal
 * count), keeping each assertion focused on the one rule under test. Shared by the unit tests and
 * available to seed scripts so there is a single source of truth for "a plausible Player/Match".
 */

export function buildPlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: overrides.id ?? randomUUID(),
    externalId: null,
    name: "Test Player",
    club: "Test FC",
    position: "MID",
    priceInMillions: 5,
    availabilityStatus: "AVAILABLE",
    availabilityReason: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

export function buildMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: overrides.id ?? randomUUID(),
    externalId: null,
    gameweekId: overrides.gameweekId ?? randomUUID(),
    homeClub: "Home FC",
    awayClub: "Away FC",
    kickoffAt: new Date("2026-07-01T14:00:00Z"),
    status: "COMPLETED",
    finalHomeScore: 0,
    finalAwayScore: 0,
    ...overrides,
  };
}

/** A raw imported stat line. Defaults to a full 90-minute appearance with no other events. */
export function buildPlayerMatchStat(
  overrides: Partial<PlayerMatchStat> & { playerId: string; matchId: string },
): PlayerMatchStat {
  return {
    id: overrides.id ?? randomUUID(),
    minutesPlayed: 90,
    goalsScored: 0,
    assists: 0,
    savesCount: 0,
    ownGoalsScored: 0,
    penaltiesWon: 0,
    penaltiesConceded: 0,
    receivedYellowCard: false,
    receivedRedCard: false,
    ...overrides,
  };
}

export function buildGameweek(overrides: Partial<Gameweek> = {}): Gameweek {
  return {
    id: overrides.id ?? randomUUID(),
    number: 1,
    deadlineAt: new Date("2026-07-01T11:30:00Z"),
    status: "COMPLETED",
    ...overrides,
  };
}

export function buildTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: overrides.id ?? randomUUID(),
    leagueId: overrides.leagueId ?? randomUUID(),
    userId: overrides.userId ?? randomUUID(),
    name: "Test Team",
    formation: null,
    rosterSlots: [],
    captainPlayerId: null,
    viceCaptainPlayerId: null,
    remainingBudgetInMillions: 0,
    bankedFreeTransferCount: 0,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

export function buildLeague(overrides: Partial<League> = {}): League {
  return {
    id: overrides.id ?? randomUUID(),
    name: "Test League",
    inviteCode: "TEST123",
    commissionerUserId: overrides.commissionerUserId ?? randomUUID(),
    areSettingsLocked: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

/** Convenience for building a roster slot; starting unless told otherwise. */
export function buildRosterSlot(playerId: string, isStarting = true): TeamRosterSlot {
  return { playerId, isStarting };
}

/** A player at a given position with a stable id, for tests that key off position-based scoring. */
export function buildPlayerAtPosition(position: PlayerPosition, overrides: Partial<Player> = {}): Player {
  return buildPlayer({ position, ...overrides });
}
