import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { db } from "../client";
import { players } from "../schema";
import {
  DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION,
  type Player,
  type PlayerAvailabilityStatus,
  type PlayerPosition,
} from "../../domain";

function toPlayer(row: typeof players.$inferSelect): Player {
  return {
    id: row.id,
    externalId: row.externalId,
    name: row.name,
    club: row.club,
    position: row.position,
    priceInMillions: row.priceInMillions,
    availabilityStatus: row.availabilityStatus,
    availabilityReason: row.availabilityReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function findById(id: string): Promise<Player | null> {
  const [row] = await db.select().from(players).where(eq(players.id, id));
  return row ? toPlayer(row) : null;
}

export async function findByExternalId(externalId: string): Promise<Player | null> {
  const [row] = await db.select().from(players).where(eq(players.externalId, externalId));
  return row ? toPlayer(row) : null;
}

export async function findManyByIds(ids: string[]): Promise<Player[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(players).where(inArray(players.id, ids));
  return rows.map(toPlayer);
}

export async function findMany(filters: { club?: string; position?: PlayerPosition }): Promise<Player[]> {
  const conditions = [];
  if (filters.club) conditions.push(eq(players.club, filters.club));
  if (filters.position) conditions.push(eq(players.position, filters.position));

  const rows = conditions.length > 0 ? await db.select().from(players).where(and(...conditions)) : await db.select().from(players);
  return rows.map(toPlayer);
}

export async function updatePrice(playerId: string, priceInMillions: number): Promise<void> {
  await db.update(players).set({ priceInMillions, updatedAt: new Date() }).where(eq(players.id, playerId));
}

/**
 * Inserts a never-before-seen Player at the position's placeholder price, or refreshes the
 * mutable fields (name/club/position can change — transfers, name corrections) of one already
 * linked to this externalId.
 */
export async function upsertFromRosterImport(entry: {
  externalId: string;
  name: string;
  club: string;
  position: PlayerPosition;
}): Promise<void> {
  await db
    .insert(players)
    .values({
      id: randomUUID(),
      externalId: entry.externalId,
      name: entry.name,
      club: entry.club,
      position: entry.position,
      priceInMillions: DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION[entry.position],
    })
    .onConflictDoUpdate({
      target: players.externalId,
      set: {
        name: entry.name,
        club: entry.club,
        position: entry.position,
        updatedAt: new Date(),
      },
    });
}

export async function setAvailability(
  playerId: string,
  availabilityStatus: PlayerAvailabilityStatus,
  availabilityReason: string | null,
): Promise<void> {
  await db.update(players).set({ availabilityStatus, availabilityReason, updatedAt: new Date() }).where(eq(players.id, playerId));
}

/** Resets every linked Player not named in the latest injuries pull back to AVAILABLE — provider injury lists are absence-only, so dropping off the list means a player has recovered/been recalled. */
export async function resetAvailabilityExceptExternalIds(externalIds: string[]): Promise<void> {
  const condition =
    externalIds.length > 0
      ? and(isNotNull(players.externalId), notInArray(players.externalId, externalIds))
      : isNotNull(players.externalId);
  await db.update(players).set({ availabilityStatus: "AVAILABLE", availabilityReason: null, updatedAt: new Date() }).where(condition);
}
