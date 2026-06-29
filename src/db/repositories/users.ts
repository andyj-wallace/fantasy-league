import { eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { users } from "../schema";
import type { User } from "../../domain";

function toUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    createdAt: row.createdAt,
  };
}

export async function findById(id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ? toUser(row) : null;
}

export async function findManyByIds(ids: string[]): Promise<User[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(users).where(inArray(users.id, ids));
  return rows.map(toUser);
}

export async function findByEmail(email: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row ? toUser(row) : null;
}

export async function insert(user: User): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({ id: user.id, email: user.email, displayName: user.displayName })
    .returning();
  return toUser(row!);
}
