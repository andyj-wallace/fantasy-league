import { randomUUID } from "node:crypto";
import {
  gameweeksRepository,
  matchesRepository,
  matchGoalEventsRepository,
  pendingConfirmationPassesRepository,
  playerMatchStatsRepository,
  playersRepository,
} from "../db/repositories";
import type { Match, MatchGoalEvent, PlayerMatchStat } from "../domain";
import type { FootballDataProvider, ProviderFixture, ProviderGoalEvent, ProviderPlayerMatchStat } from "./footballDataProvider";
import { mapApiFootballStatusToMatchStatus } from "./footballMatchStatusMapping";

export interface ImportMatchDataResult {
  /** Matches that just reached COMPLETED — drives calculatePlayerScores. */
  newlyCompletedMatchIds: string[];
  /** Matches that just reached POSTPONED or VOIDED — drives awardPostponedMatchTransfers. Either
   * way the fixture isn't happening as scheduled, so the affected clubs' players get the same
   * free-transfer award (fantasy_league_v1_design.txt's "Postponed Matches" rule). */
  newlyDisruptedMatchIds: string[];
}

/** How long before a round's earliest known kickoff its Gameweek deadline locks. */
const GAMEWEEK_DEADLINE_BUFFER_MS = 90 * 60 * 1000;

/** How long after MATCH_COMPLETED the confirmation re-poll for late VAR corrections fires. */
const CONFIRMATION_PASS_DELAY_MS = 50 * 60 * 1000;

/** Pulls the trailing round number out of a label like "Regular Season - 14". */
function parseGameweekNumber(roundLabel: string): number {
  const match = /(\d+)\s*$/.exec(roundLabel);
  if (!match) throw new Error(`Could not parse a gameweek number out of round label "${roundLabel}"`);
  return Number(match[1]);
}

/** Exported for reuse by the confirmation-pass re-poll, which re-resolves the same provider
 * stats shape against our internal Player rows. */
export async function resolvePlayerMatchStats(matchId: string, providerStats: ProviderPlayerMatchStat[]): Promise<PlayerMatchStat[]> {
  const stats: PlayerMatchStat[] = [];
  for (const providerStat of providerStats) {
    const player = await playersRepository.findByExternalId(providerStat.externalPlayerId);
    if (!player) continue; // provider knows a player we haven't imported via the roster importer yet — skip rather than fail the whole match import

    stats.push({
      id: randomUUID(),
      matchId,
      playerId: player.id,
      minutesPlayed: providerStat.minutesPlayed,
      goalsScored: providerStat.goalsScored,
      assists: providerStat.assists,
      savesCount: providerStat.savesCount,
      ownGoalsScored: providerStat.ownGoalsScored,
      penaltiesWon: providerStat.penaltiesWon,
      penaltiesConceded: providerStat.penaltiesConceded,
      receivedYellowCard: providerStat.receivedYellowCard,
      receivedRedCard: providerStat.receivedRedCard,
      wasInStartingLineup: providerStat.wasInStartingLineup,
    });
  }
  return stats;
}

/** Exported for reuse by the confirmation-pass re-poll, alongside resolvePlayerMatchStats.
 * Unlike stats, an unresolvable scorer does NOT drop the event — the timeline has to stay
 * complete for the running scoreline walk in identifyDecisiveGoals to be correct. */
export async function resolveMatchGoalEvents(matchId: string, providerGoalEvents: ProviderGoalEvent[]): Promise<MatchGoalEvent[]> {
  const goalEvents: MatchGoalEvent[] = [];
  for (const providerGoalEvent of providerGoalEvents) {
    const scorer = providerGoalEvent.externalScorerPlayerId
      ? await playersRepository.findByExternalId(providerGoalEvent.externalScorerPlayerId)
      : null;
    const assister = providerGoalEvent.externalAssistPlayerId
      ? await playersRepository.findByExternalId(providerGoalEvent.externalAssistPlayerId)
      : null;

    goalEvents.push({
      id: randomUUID(),
      matchId,
      scorerPlayerId: scorer?.id ?? null,
      assistPlayerId: assister?.id ?? null,
      beneficiaryClub: providerGoalEvent.beneficiaryClub,
      goalType: providerGoalEvent.goalType,
      elapsedMinute: providerGoalEvent.elapsedMinute,
      addedTimeMinute: providerGoalEvent.addedTimeMinute,
      sequenceIndex: providerGoalEvent.sequenceIndex,
    });
  }
  return goalEvents;
}

/**
 * Persists an already-fetched batch of provider fixtures (from either discovery or a live-list
 * poll). For each fixture: resolves/creates its Gameweek, maps its status, and upserts the Match
 * by externalId. For any Match that just reached COMPLETED (and only then), also imports its raw
 * per-player stats and schedules a confirmation re-poll. Returns the IDs of matches that just
 * transitioned into COMPLETED or into a disrupted state (POSTPONED/VOIDED) so the caller can
 * drive the right downstream worker off of exactly the right set.
 */
export async function importMatchData(
  provider: FootballDataProvider,
  fixtures: ProviderFixture[],
): Promise<ImportMatchDataResult> {
  console.log(`[importMatchData] processing ${fixtures.length} fixtures...`);
  const newlyCompletedMatchIds: string[] = [];
  const newlyDisruptedMatchIds: string[] = [];

  for (const fixture of fixtures) {
    const gameweekNumber = parseGameweekNumber(fixture.roundLabel);
    const gameweek = await gameweeksRepository.upsertByNumber(
      gameweekNumber,
      new Date(fixture.kickoffAt.getTime() - GAMEWEEK_DEADLINE_BUFFER_MS),
    );

    const status = mapApiFootballStatusToMatchStatus(fixture.statusShortCode);
    const existingMatch = await matchesRepository.findByExternalId(fixture.externalId);
    const previousStatus = existingMatch?.status;

    const match: Match = {
      id: existingMatch?.id ?? randomUUID(),
      externalId: fixture.externalId,
      gameweekId: gameweek.id,
      homeClub: fixture.homeClub,
      awayClub: fixture.awayClub,
      kickoffAt: fixture.kickoffAt,
      status,
      finalHomeScore: fixture.finalHomeScore,
      finalAwayScore: fixture.finalAwayScore,
    };
    await matchesRepository.upsert(match);

    if (status === "COMPLETED" && previousStatus !== undefined && previousStatus !== "COMPLETED") {
      const { playerStats, goalEvents: providerGoalEvents } = await provider.fetchFixturePlayerStatsAndGoalEvents(fixture.externalId);
      const stats = await resolvePlayerMatchStats(match.id, playerStats);
      await playerMatchStatsRepository.insertMany(stats);
      await matchGoalEventsRepository.insertMany(await resolveMatchGoalEvents(match.id, providerGoalEvents));
      await pendingConfirmationPassesRepository.schedule(
        match.id,
        fixture.externalId,
        new Date(Date.now() + CONFIRMATION_PASS_DELAY_MS),
      );
      newlyCompletedMatchIds.push(match.id);
    }

    const isDisrupted = status === "POSTPONED" || status === "VOIDED";
    const wasAlreadyDisrupted = previousStatus === "POSTPONED" || previousStatus === "VOIDED";
    if (isDisrupted && !wasAlreadyDisrupted) {
      newlyDisruptedMatchIds.push(match.id);
    }
  }

  console.log(`[importMatchData] done — ${newlyCompletedMatchIds.length} newly completed, ${newlyDisruptedMatchIds.length} newly disrupted`);
  return { newlyCompletedMatchIds, newlyDisruptedMatchIds };
}
