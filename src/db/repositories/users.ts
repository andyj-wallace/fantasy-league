import { eq, inArray } from "drizzle-orm";
import { db } from "../client";
import { users } from "../schema";
import type { User } from "../../domain";

function toUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    cognitoSub: row.cognitoSub,
    handle: row.handle,
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

export async function findByCognitoSub(cognitoSub: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.cognitoSub, cognitoSub));
  return row ? toUser(row) : null;
}

/** Backfills the Cognito identity link on a user that predates it (found by email before the
 * cognito_sub/handle columns were populated). */
export async function linkCognitoIdentity(
  userId: string,
  identity: { cognitoSub: string; handle: string | null },
): Promise<void> {
  await db.update(users).set({ cognitoSub: identity.cognitoSub, handle: identity.handle }).where(eq(users.id, userId));
}

export async function insert(user: User): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({ id: user.id, email: user.email, displayName: user.displayName, cognitoSub: user.cognitoSub, handle: user.handle })
    .returning();
  return toUser(row!);
}
