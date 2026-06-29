import { and, eq } from "drizzle-orm";
import { db } from "../client";
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

export async function insert(transfer: Transfer): Promise<void> {
  await db.insert(transfers).values({
    id: transfer.id,
    teamId: transfer.teamId,
    gameweekId: transfer.gameweekId,
    playerOutId: transfer.playerOutId,
    playerInId: transfer.playerInId,
    pointsCost: transfer.pointsCost,
    createdAt: transfer.createdAt,
  });
}

/** A Team's transfers within one Gameweek — what the transfers screen shows as "made this gameweek". */
export async function findByTeamAndGameweek(teamId: string, gameweekId: string): Promise<Transfer[]> {
  const rows = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.teamId, teamId), eq(transfers.gameweekId, gameweekId)));
  return rows.map(toTransfer);
}
