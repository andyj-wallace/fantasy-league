import { and, eq } from "drizzle-orm";
import { db } from "../client";
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
  const rows = await db.select().from(teams);
  return rows.map(toTeamRow);
}

export async function findById(id: string): Promise<TeamRow | null> {
  const [row] = await db.select().from(teams).where(eq(teams.id, id));
  return row ? toTeamRow(row) : null;
}

export async function findByLeagueId(leagueId: string): Promise<TeamRow[]> {
  const rows = await db.select().from(teams).where(eq(teams.leagueId, leagueId));
  return rows.map(toTeamRow);
}

export async function findByLeagueAndUser(leagueId: string, userId: string): Promise<TeamRow | null> {
  const [row] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), eq(teams.userId, userId)));
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
    .where(eq(teams.userId, userId));
  return rows.map((row) => ({ team: toTeamRow(row.team), league: toLeague(row.league) }));
}

export async function findRosterSlots(teamId: string): Promise<TeamRosterSlot[]> {
  return db
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

/** Replaces a Team's roster and the resulting budget in one transaction — delete-then-insert keeps re-running idempotent. */
export async function replaceRosterSlots(
  teamId: string,
  rosterSlots: TeamRosterSlot[],
  remainingBudgetInMillions: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(teamRosterSlots).where(eq(teamRosterSlots.teamId, teamId));
    if (rosterSlots.length > 0) {
      await tx.insert(teamRosterSlots).values(
        rosterSlots.map((slot) => ({ teamId, playerId: slot.playerId, isStarting: slot.isStarting })),
      );
    }
    await tx.update(teams).set({ remainingBudgetInMillions, updatedAt: new Date() }).where(eq(teams.id, teamId));
  });
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
): Promise<void> {
  await db
    .update(teams)
    .set({
      remainingBudgetInMillions: fields.remainingBudgetInMillions,
      bankedFreeTransferCount: fields.bankedFreeTransferCount,
      updatedAt: new Date(),
    })
    .where(eq(teams.id, teamId));
}

/** Deletes a Team and its roster slots. Does not cascade to transfers/scores/standings rows
 * that reference this team — deleting a Team with score history will fail on the FK constraint. */
export async function deleteById(teamId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(teamRosterSlots).where(eq(teamRosterSlots.teamId, teamId));
    await tx.delete(teams).where(eq(teams.id, teamId));
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

/** Banks `amount` more free transfers for a Team, capped at MAX_BANKED_FREE_TRANSFER_COUNT. */
export async function incrementBankedFreeTransferCount(teamId: string, amount = 1): Promise<void> {
  const team = await findById(teamId);
  if (!team) return;
  const bankedFreeTransferCount = Math.min(team.bankedFreeTransferCount + amount, MAX_BANKED_FREE_TRANSFER_COUNT);
  await db.update(teams).set({ bankedFreeTransferCount, updatedAt: new Date() }).where(eq(teams.id, teamId));
}
