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
    isInCurrentSeasonSquad: row.isInCurrentSeasonSquad,
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

export async function findMany(filters: {
  club?: string;
  position?: PlayerPosition;
  /** Restricts to players a roster import last saw in a current Premier League squad. The default
   * is deliberately unfiltered: hydration workers and score attribution need every row, including
   * players whose club has since left the league. User-facing reads opt in. */
  onlyInCurrentSeasonSquad?: boolean;
}): Promise<Player[]> {
  const conditions = [];
  if (filters.club) conditions.push(eq(players.club, filters.club));
  if (filters.position) conditions.push(eq(players.position, filters.position));
  if (filters.onlyInCurrentSeasonSquad) conditions.push(eq(players.isInCurrentSeasonSquad, true));

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
        // Seeing a player in an import is itself the proof he is in the league this season, so
        // this also un-hides anyone a previous sweep hid who has since transferred back in.
        isInCurrentSeasonSquad: true,
        updatedAt: new Date(),
      },
    });
}

/** How many players a roster import currently counts as being in the league — the denominator the
 * caller's sweep-size sanity check is measured against. */
export async function countPlayersInCurrentSeasonSquad(): Promise<number> {
  const rows = await db
    .select({ id: players.id })
    .from(players)
    .where(eq(players.isInCurrentSeasonSquad, true));
  return rows.length;
}

/** How many players hidePlayersOutsideCurrentSeasonSquads would hide, without hiding them. Lets a
 * caller look at the size of a sweep before committing to it — a well-formed provider response
 * that is nonetheless wrong about the league produces a plausible import and an implausible
 * sweep, and only the second of those is visible in advance. */
export async function countPlayersInCurrentSeasonSquadMissingFromImport(seenExternalIds: string[]): Promise<number> {
  if (seenExternalIds.length === 0) return 0;
  const rows = await db
    .select({ id: players.id })
    .from(players)
    .where(
      and(
        eq(players.isInCurrentSeasonSquad, true),
        isNotNull(players.externalId),
        notInArray(players.externalId, seenExternalIds),
      ),
    );
  return rows.length;
}

/**
 * Hides every player the caller's roster import did not see, and returns how many were newly
 * hidden. Rows are never deleted — PlayerScore and PlayerMatchStat reference them, and a hidden
 * player un-hides himself simply by turning up in a later import.
 *
 * Callers must only invoke this after an import they believe to be complete; a partial one would
 * hide most of the league. importPlayerRoster.ts owns that judgement.
 */
export async function hidePlayersOutsideCurrentSeasonSquads(seenExternalIds: string[]): Promise<number> {
  if (seenExternalIds.length === 0) return 0;
  const hidden = await db
    .update(players)
    .set({ isInCurrentSeasonSquad: false, updatedAt: new Date() })
    .where(
      and(
        eq(players.isInCurrentSeasonSquad, true),
        isNotNull(players.externalId),
        notInArray(players.externalId, seenExternalIds),
      ),
    )
    .returning({ id: players.id });
  return hidden.length;
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
