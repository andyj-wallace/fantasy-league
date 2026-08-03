import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { leagues, players, teamRosterSlots, teams } from "../schema";
import { MAX_BANKED_FREE_TRANSFER_COUNT, type League, type StartingFormation, type Team, type TeamRosterSlot } from "../../domain";

/**
 * Scalar Team columns only — deliberately not the full `Team` domain type, which embeds
 * `rosterSlots`. Use findFullTeamById to get a fully-assembled Team (joins team_roster_slots).
 */
export interface TeamRow {
  id: string;
  leagueId: string;
  userId: string;
  name: string;
  formation: StartingFormation | null;
  captainPlayerId: string | null;
  viceCaptainPlayerId: string | null;
  remainingBudgetInMillions: number;
  bankedFreeTransferCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTeamInput {
  id: string;
  leagueId: string;
  userId: string;
  name: string;
  remainingBudgetInMillions: number;
  bankedFreeTransferCount: number;
}

function toTeamRow(row: typeof teams.$inferSelect): TeamRow {
  return {
    id: row.id,
    leagueId: row.leagueId,
    userId: row.userId,
    name: row.name,
    formation: row.formation,
    captainPlayerId: row.captainPlayerId,
    viceCaptainPlayerId: row.viceCaptainPlayerId,
    remainingBudgetInMillions: row.remainingBudgetInMillions,
    bankedFreeTransferCount: row.bankedFreeTransferCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function findAll(): Promise<TeamRow[]> {
  const rows = await db.select().from(teams).where(isNull(teams.removedAt));
  return rows.map(toTeamRow);
}

export async function findById(id: string): Promise<TeamRow | null> {
  const [row] = await db.select().from(teams).where(eq(teams.id, id));
  return row ? toTeamRow(row) : null;
}

/** Like findById but issues SELECT … FOR UPDATE — must be called inside a transaction to have
 * any effect. Serializes concurrent transfers that race to read budget/bankedFreeTransferCount. */
export async function findByIdForUpdate(id: string, tx: DbOrTx): Promise<TeamRow | null> {
  const [row] = await tx.select().from(teams).where(eq(teams.id, id)).for("update");
  return row ? toTeamRow(row) : null;
}

export async function findByLeagueId(leagueId: string, tx?: DbOrTx): Promise<TeamRow[]> {
  const rows = await (tx ?? db)
    .select()
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), isNull(teams.removedAt)));
  return rows.map(toTeamRow);
}

export async function findByLeagueAndUser(leagueId: string, userId: string): Promise<TeamRow | null> {
  const [row] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), eq(teams.userId, userId), isNull(teams.removedAt)));
  return row ? toTeamRow(row) : null;
}

function toLeague(row: typeof leagues.$inferSelect): League {
  return {
    id: row.id,
    name: row.name,
    inviteCode: row.inviteCode,
    commissionerUserId: row.commissionerUserId,
    areSettingsLocked: row.areSettingsLocked,
    createdAt: row.createdAt,
  };
}

/** Powers a "your leagues" home view — every Team a user holds, paired with that Team's League. */
export async function findWithLeagueByUserId(userId: string): Promise<{ team: TeamRow; league: League }[]> {
  const rows = await db
    .select({ team: teams, league: leagues })
    .from(teams)
    .innerJoin(leagues, eq(teams.leagueId, leagues.id))
    .where(and(eq(teams.userId, userId), isNull(teams.removedAt)));
  return rows.map((row) => ({ team: toTeamRow(row.team), league: toLeague(row.league) }));
}

export async function findRosterSlots(teamId: string, tx?: DbOrTx): Promise<TeamRosterSlot[]> {
  return (tx ?? db)
    .select({ playerId: teamRosterSlots.playerId, isStarting: teamRosterSlots.isStarting })
    .from(teamRosterSlots)
    .where(eq(teamRosterSlots.teamId, teamId));
}

function toTeam(row: TeamRow, rosterSlots: TeamRosterSlot[]): Team {
  return {
    id: row.id,
    leagueId: row.leagueId,
    userId: row.userId,
    name: row.name,
    formation: row.formation,
    rosterSlots,
    captainPlayerId: row.captainPlayerId,
    viceCaptainPlayerId: row.viceCaptainPlayerId,
    remainingBudgetInMillions: row.remainingBudgetInMillions,
    bankedFreeTransferCount: row.bankedFreeTransferCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function findFullTeamById(id: string): Promise<Team | null> {
  const row = await findById(id);
  if (!row) return null;
  const rosterSlots = await findRosterSlots(id);
  return toTeam(row, rosterSlots);
}

/** Creates the Team row a joinLeague call needs: no formation/captain/vice-captain yet, full budget. */
export async function insert(input: NewTeamInput): Promise<Team> {
  const [row] = await db
    .insert(teams)
    .values({
      id: input.id,
      leagueId: input.leagueId,
      userId: input.userId,
      name: input.name,
      remainingBudgetInMillions: input.remainingBudgetInMillions,
      bankedFreeTransferCount: input.bankedFreeTransferCount,
    })
    .returning();
  return toTeam(toTeamRow(row!), []);
}

/**
 * Like insert, but returns null instead of creating a duplicate when this user already has an
 * ACTIVE Team in this league (the teams_league_id_user_id_idx unique index) — matches the old
 * "already joined" 409 semantics. If this user's only Team in this league was soft-removed
 * (removedAt set), that same row is revived instead: roster/formation/captaincy/budget reset to
 * fresh-join defaults, removedAt cleared, original id kept (so its historical teamScores/
 * leagueStandings/transfers stay attached to that manager's prior-stint record). One atomic
 * INSERT … ON CONFLICT … DO UPDATE … WHERE removedAt IS NOT NULL — no read-then-insert window, so
 * a double-submitted joinLeague can't create two teams or double-revive one. Used by joinLeague;
 * createLeague keeps insert (first team, no race).
 */
export async function insertOrRevive(input: NewTeamInput): Promise<Team | null> {
  const [row] = await db
    .insert(teams)
    .values({
      id: input.id,
      leagueId: input.leagueId,
      userId: input.userId,
      name: input.name,
      remainingBudgetInMillions: input.remainingBudgetInMillions,
      bankedFreeTransferCount: input.bankedFreeTransferCount,
    })
    .onConflictDoUpdate({
      target: [teams.leagueId, teams.userId],
      set: {
        name: input.name,
        formation: null,
        captainPlayerId: null,
        viceCaptainPlayerId: null,
        remainingBudgetInMillions: input.remainingBudgetInMillions,
        bankedFreeTransferCount: input.bankedFreeTransferCount,
        removedAt: null,
        updatedAt: new Date(),
      },
      setWhere: sql`${teams.removedAt} is not null`,
    })
    .returning();
  return row ? toTeam(toTeamRow(row), []) : null;
}

/** Replaces a Team's roster and the resulting budget atomically. Pass an outer `tx` to
 * participate in a caller-owned transaction; omit to run in its own transaction. */
export async function replaceRosterSlots(
  teamId: string,
  rosterSlots: TeamRosterSlot[],
  remainingBudgetInMillions: number,
  tx?: DbOrTx,
): Promise<void> {
  const execute = async (client: DbOrTx) => {
    await client.delete(teamRosterSlots).where(eq(teamRosterSlots.teamId, teamId));
    if (rosterSlots.length > 0) {
      await client.insert(teamRosterSlots).values(
        rosterSlots.map((slot) => ({ teamId, playerId: slot.playerId, isStarting: slot.isStarting })),
      );
    }
    await client.update(teams).set({ remainingBudgetInMillions, updatedAt: new Date() }).where(eq(teams.id, teamId));
  };
  if (tx) {
    await execute(tx);
  } else {
    await db.transaction(execute);
  }
}

export async function updateLineup(
  teamId: string,
  lineup: { formation: StartingFormation; captainPlayerId: string; viceCaptainPlayerId: string },
): Promise<void> {
  await db
    .update(teams)
    .set({
      formation: lineup.formation,
      captainPlayerId: lineup.captainPlayerId,
      viceCaptainPlayerId: lineup.viceCaptainPlayerId,
      updatedAt: new Date(),
    })
    .where(eq(teams.id, teamId));
}

export async function updateAfterTransfer(
  teamId: string,
  fields: { remainingBudgetInMillions: number; bankedFreeTransferCount: number },
  tx?: DbOrTx,
): Promise<void> {
  await (tx ?? db)
    .update(teams)
    .set({
      remainingBudgetInMillions: fields.remainingBudgetInMillions,
      bankedFreeTransferCount: fields.bankedFreeTransferCount,
      updatedAt: new Date(),
    })
    .where(eq(teams.id, teamId));
}

/** Soft-removes a manager's Team: clears its current roster (roster is live state, not a
 * historical record, unlike scores/standings/transfers which must never be touched — a stale
 * roster would otherwise keep counting toward ownership/price-update signals) and stamps
 * removedAt. Nothing referencing this team is ever deleted — historical teamScores/
 * leagueStandings/transfers rows stay exactly as computed, forever, and active-only reads
 * (findByLeagueId, findAll, the leagueStandings join, etc.) simply exclude this team going
 * forward. A later insertOrRevive by the same user in the same league un-removes this same row
 * rather than creating a new one. */
export async function markRemoved(teamId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(teamRosterSlots).where(eq(teamRosterSlots.teamId, teamId));
    await tx.update(teams).set({ removedAt: new Date(), updatedAt: new Date() }).where(eq(teams.id, teamId));
  });
}

/** Distinct IDs of every Team rostering at least one player from the given club. */
export async function findTeamIdsWithPlayerFromClub(club: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ teamId: teamRosterSlots.teamId })
    .from(teamRosterSlots)
    .innerJoin(players, eq(teamRosterSlots.playerId, players.id))
    .where(eq(players.club, club));
  return rows.map((row) => row.teamId);
}

/** Total number of Team rows across all leagues — the denominator for ownership and transfer
 * activity scores in the monthly price update formula. */
export async function countAll(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(teams).where(isNull(teams.removedAt));
  return row?.value ?? 0;
}

/** Number of managers currently in a league — joinLeague checks this against
 * MAX_MANAGERS_PER_LEAGUE before letting anyone else in. */
export async function countByLeagueId(leagueId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), isNull(teams.removedAt)));
  return row?.value ?? 0;
}

/** How many teams currently roster each of the given players — the ownership signal for the
 * monthly price update formula. Players with zero rosters are omitted (ownership = 0 by absence). */
export async function countRosteringByPlayerIds(
  playerIds: string[],
): Promise<{ playerId: string; teamsRostering: number }[]> {
  if (playerIds.length === 0) return [];
  const rows = await db
    .select({ playerId: teamRosterSlots.playerId, teamsRostering: count() })
    .from(teamRosterSlots)
    .where(inArray(teamRosterSlots.playerId, playerIds))
    .groupBy(teamRosterSlots.playerId);
  return rows.map((row) => ({ playerId: row.playerId, teamsRostering: row.teamsRostering }));
}

/** Banks `amount` more free transfers for a Team, capped at MAX_BANKED_FREE_TRANSFER_COUNT.
 * Single atomic UPDATE — no prior SELECT, so concurrent worker calls can't race and lose an increment. */
export async function incrementBankedFreeTransferCount(teamId: string, amount = 1): Promise<void> {
  await db
    .update(teams)
    .set({
      bankedFreeTransferCount: sql`LEAST(${teams.bankedFreeTransferCount} + ${amount}, ${MAX_BANKED_FREE_TRANSFER_COUNT})`,
      updatedAt: new Date(),
    })
    .where(eq(teams.id, teamId));
}
