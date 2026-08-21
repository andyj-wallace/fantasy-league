import { StubFootballDataProvider, type ProviderFixture, type ProviderFixtureDetail } from "../../workers/footballDataProvider";
import {
  findCheckpoint,
  resolveFixtureSnapshot,
  SCENARIO_FIXTURES,
  SCENARIO_STATS_BY_FIXTURE_EXTERNAL_ID,
  toRealTime,
  type CheckpointId,
} from "./gameweekLifecycleScenario";

/**
 * A FootballDataProvider that replays the recorded-smoke scenario instead of calling
 * API-Football. Point it at a checkpoint and it reports every scenario fixture in the state that
 * checkpoint prescribes, with kickoff times converted so the checkpoint's virtual "now" lands on
 * the real wall clock. Everything else inherits StubFootballDataProvider's no-ops (empty roster,
 * no injuries, free quota), so runWorkerCycle's other import steps run harmlessly.
 */
export class ScriptedFootballDataProvider extends StubFootballDataProvider {
  private currentCheckpointId: CheckpointId = "A";

  setCurrentCheckpoint(checkpointId: CheckpointId): void {
    this.currentCheckpointId = checkpointId;
  }

  override async fetchSeasonFixtures(): Promise<ProviderFixture[]> {
    const checkpoint = findCheckpoint(this.currentCheckpointId);
    const realNow = new Date();
    return SCENARIO_FIXTURES.map((fixture) => {
      const snapshot = resolveFixtureSnapshot(fixture, checkpoint.id);
      return {
        externalId: fixture.externalId,
        roundLabel: fixture.roundLabel,
        homeClub: fixture.homeClub,
        awayClub: fixture.awayClub,
        kickoffAt: toRealTime(checkpoint.virtualNowHours, snapshot.kickoffVirtualHours, realNow),
        statusShortCode: snapshot.statusShortCode,
        finalHomeScore: snapshot.finalHomeScore,
        finalAwayScore: snapshot.finalAwayScore,
      };
    });
  }

  /** Called by importMatchData exactly once per fixture, on its non-COMPLETED -> COMPLETED
   * transition — so a static per-fixture stats map is all a scripted season needs. The goal
   * timeline is deliberately empty: this scenario asserts on captaincy and standings, and a
   * scored match with no goal events simply yields a zero game-state bonus everywhere. */
  override async fetchFixturePlayerStatsAndGoalEvents(externalFixtureId: string): Promise<ProviderFixtureDetail> {
    const statLines = SCENARIO_STATS_BY_FIXTURE_EXTERNAL_ID[externalFixtureId] ?? [];
    const playerStats = statLines.map((line) => ({
      externalPlayerId: line.externalPlayerId,
      minutesPlayed: line.minutesPlayed ?? 90,
      goalsScored: line.goalsScored ?? 0,
      assists: line.assists ?? 0,
      savesCount: line.savesCount ?? 0,
      ownGoalsScored: 0,
      penaltiesWon: 0,
      penaltiesConceded: 0,
      receivedYellowCard: line.receivedYellowCard ?? false,
      receivedRedCard: line.receivedRedCard ?? false,
      wasInStartingLineup: true,
    }));
    return { playerStats, goalEvents: [] };
  }
}
