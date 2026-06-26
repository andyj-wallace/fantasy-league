import { matchesRepository, playerMatchStatsRepository } from "../db/repositories";
import type { FootballDataProvider } from "./footballDataProvider";

export interface ImportMatchDataResult {
  /** Matches that just reached COMPLETED — drives calculatePlayerScores. */
  newlyCompletedMatchIds: string[];
  /** Matches that just reached POSTPONED — drives awardPostponedMatchTransfers. */
  newlyPostponedMatchIds: string[];
}

/**
 * Pulls match updates from the provider and persists them. For any Match that just reached
 * COMPLETED (and only then), also imports its raw per-player stats. Returns the IDs of matches
 * that just transitioned into COMPLETED or POSTPONED so the caller can drive the right
 * downstream worker off of exactly the right set.
 */
export async function importMatchData(provider: FootballDataProvider): Promise<ImportMatchDataResult> {
  const matchUpdates = await provider.fetchMatchUpdates();
  const newlyCompletedMatchIds: string[] = [];
  const newlyPostponedMatchIds: string[] = [];

  for (const match of matchUpdates) {
    const existingMatch = await matchesRepository.findById(match.id);
    const previousStatus = existingMatch?.status;
    await matchesRepository.upsert(match);

    if (match.status === "COMPLETED" && previousStatus !== "COMPLETED") {
      const stats = await provider.fetchPlayerMatchStats(match.id);
      await playerMatchStatsRepository.insertMany(stats);
      newlyCompletedMatchIds.push(match.id);
    }

    if (match.status === "POSTPONED" && previousStatus !== "POSTPONED") {
      newlyPostponedMatchIds.push(match.id);
    }
  }

  return { newlyCompletedMatchIds, newlyPostponedMatchIds };
}
