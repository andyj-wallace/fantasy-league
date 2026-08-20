import { eq } from "drizzle-orm";
import { db } from "../client";
import { matchGoalEvents } from "../schema";
import type { MatchGoalEvent } from "../../domain";

function toMatchGoalEvent(row: typeof matchGoalEvents.$inferSelect): MatchGoalEvent {
  return {
    id: row.id,
    matchId: row.matchId,
    scorerPlayerId: row.scorerPlayerId,
    assistPlayerId: row.assistPlayerId,
    beneficiaryClub: row.beneficiaryClub,
    goalType: row.goalType,
    elapsedMinute: row.elapsedMinute,
    addedTimeMinute: row.addedTimeMinute,
    sequenceIndex: row.sequenceIndex,
  };
}

export async function findByMatchId(matchId: string): Promise<MatchGoalEvent[]> {
  const rows = await db.select().from(matchGoalEvents).where(eq(matchGoalEvents.matchId, matchId));
  return rows.map(toMatchGoalEvent);
}

export async function insertMany(goalEvents: MatchGoalEvent[]): Promise<void> {
  if (goalEvents.length === 0) return;
  await db.insert(matchGoalEvents).values(
    goalEvents.map((goalEvent) => ({
      id: goalEvent.id,
      matchId: goalEvent.matchId,
      scorerPlayerId: goalEvent.scorerPlayerId,
      assistPlayerId: goalEvent.assistPlayerId,
      beneficiaryClub: goalEvent.beneficiaryClub,
      goalType: goalEvent.goalType,
      elapsedMinute: goalEvent.elapsedMinute,
      addedTimeMinute: goalEvent.addedTimeMinute,
      sequenceIndex: goalEvent.sequenceIndex,
    })),
  );
}

/** Replaces every MatchGoalEvent for a Match — the confirmation pass re-imports the whole
 * timeline, and appending would double every goal and corrupt the running scoreline walk. */
export async function replaceForMatch(matchId: string, goalEvents: MatchGoalEvent[]): Promise<void> {
  await db.delete(matchGoalEvents).where(eq(matchGoalEvents.matchId, matchId));
  await insertMany(goalEvents);
}
