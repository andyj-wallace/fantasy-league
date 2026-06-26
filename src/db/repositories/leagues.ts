import { eq } from "drizzle-orm";
import { db } from "../client";
import { leagues } from "../schema";
import type { League } from "../../domain";

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

export async function findAll(): Promise<League[]> {
  const rows = await db.select().from(leagues);
  return rows.map(toLeague);
}

export async function findById(id: string): Promise<League | null> {
  const [row] = await db.select().from(leagues).where(eq(leagues.id, id));
  return row ? toLeague(row) : null;
}

export async function findByInviteCode(inviteCode: string): Promise<League | null> {
  const [row] = await db.select().from(leagues).where(eq(leagues.inviteCode, inviteCode));
  return row ? toLeague(row) : null;
}

export async function insert(league: League): Promise<League> {
  const [row] = await db
    .insert(leagues)
    .values({
      id: league.id,
      name: league.name,
      inviteCode: league.inviteCode,
      commissionerUserId: league.commissionerUserId,
      areSettingsLocked: league.areSettingsLocked,
    })
    .returning();
  return toLeague(row!);
}

export async function update(
  id: string,
  fields: Partial<Pick<League, "name" | "areSettingsLocked" | "inviteCode">>,
): Promise<League | null> {
  const [row] = await db.update(leagues).set(fields).where(eq(leagues.id, id)).returning();
  return row ? toLeague(row) : null;
}
