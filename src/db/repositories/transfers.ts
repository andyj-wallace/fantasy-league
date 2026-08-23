import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx } from "../client";
import { transfers } from "../schema";
import type { Transfer } from "../../domain";

function toTransfer(row: typeof transfers.$inferSelect): Transfer {
  return {
    id: row.id,
    teamId: row.teamId,
    gameweekId: row.gameweekId,
    playerOutId: row.playerOutId,
    playerInId: row.playerInId,
    pointsCost: row.pointsCost,
    createdAt: row.createdAt,
  };
}

export async function insert(transfer: Transfer, tx?: DbOrTx): Promise<void> {
  await (tx ?? db).insert(transfers).values({
    id: transfer.id,
    teamId: transfer.teamId,
    gameweekId: transfer.gameweekId,
    playerOutId: transfer.playerOutId,
    playerInId: transfer.playerInId,
    pointsCost: transfer.pointsCost,
    createdAt: transfer.createdAt,
  });
}

/** Net transfer volume per player over a rolling window — the transfer-activity signal for
 * monthly price updates. Players not transferred at all in the window are omitted (their
 * transfersIn and transfersOut are both 0 by absence). */
export async function findTransferVolumeByPlayerIds(
  playerIds: string[],
  since: Date,
): Promise<{ playerId: string; transfersIn: number; transfersOut: number }[]> {
  if (playerIds.length === 0) return [];

  const [inRows, outRows] = await Promise.all([
    db
      .select({ playerId: transfers.playerInId, transferCount: count() })
      .from(transfers)
      .where(and(inArray(transfers.playerInId, playerIds), gte(transfers.createdAt, since)))
      .groupBy(transfers.playerInId),
    db
      .select({ playerId: transfers.playerOutId, transferCount: count() })
      .from(transfers)
      .where(and(inArray(transfers.playerOutId, playerIds), gte(transfers.createdAt, since)))
      .groupBy(transfers.playerOutId),
  ]);

  const transfersInByPlayerId = new Map(inRows.map((row) => [row.playerId, row.transferCount]));
  const transfersOutByPlayerId = new Map(outRows.map((row) => [row.playerId, row.transferCount]));
  const allAffectedPlayerIds = new Set([...transfersInByPlayerId.keys(), ...transfersOutByPlayerId.keys()]);

  return [...allAffectedPlayerIds].map((playerId) => ({
    playerId,
    transfersIn: transfersInByPlayerId.get(playerId) ?? 0,
    transfersOut: transfersOutByPlayerId.get(playerId) ?? 0,
  }));
}

/**
 * What each Team's paid transfers cost it in one Gameweek, as a positive magnitude of points to
 * deduct. Grouped by team so calculateTeamScores can score a whole gameweek on one round trip
 * here instead of one per team — the scorer already loops every team in the league.
 *
 * Teams absent from the result deduct nothing: either they made no transfers, or every one was
 * covered by a banked free transfer and cost 0. Callers should treat a missing team as 0 rather
 * than expecting a zero row.
 */
export async function sumTransferPointsCostByTeamForGameweek(
  gameweekId: string,
): Promise<{ teamId: string; transferPointsCost: number }[]> {
  return db
    .select({
      teamId: transfers.teamId,
      transferPointsCost: sql<number>`coalesce(sum(${transfers.pointsCost}), 0)::int`,
    })
    .from(transfers)
    .where(eq(transfers.gameweekId, gameweekId))
    .groupBy(transfers.teamId);
}

/** A Team's transfers within one Gameweek — what the transfers screen shows as "made this gameweek". */
export async function findByTeamAndGameweek(teamId: string, gameweekId: string): Promise<Transfer[]> {
  const rows = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.teamId, teamId), eq(transfers.gameweekId, gameweekId)));
  return rows.map(toTransfer);
}
