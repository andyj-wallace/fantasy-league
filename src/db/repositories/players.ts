import { and, eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { players } from "../schema";
import type { Player, PlayerPosition } from "../../domain";

function toPlayer(row: typeof players.$inferSelect): Player {
  return {
    id: row.id,
    name: row.name,
    club: row.club,
    position: row.position,
    priceInMillions: row.priceInMillions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function findById(id: string): Promise<Player | null> {
  const [row] = await db.select().from(players).where(eq(players.id, id));
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
