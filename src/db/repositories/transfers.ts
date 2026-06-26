import { db } from "../client";
import { transfers } from "../schema";
import type { Transfer } from "../../domain";

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
