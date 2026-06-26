import type { Match, PlayerMatchStat } from "../domain";

/**
 * Boundary between our system and an external football data source (football-data.org,
 * api-football.com). Layer 5 of the build order implements this against a real provider;
 * for now only the interface and a no-op stub exist.
 */
export interface FootballDataProvider {
  fetchMatchUpdates(): Promise<Match[]>;
  fetchPlayerMatchStats(matchId: string): Promise<PlayerMatchStat[]>;
}

export class StubFootballDataProvider implements FootballDataProvider {
  async fetchMatchUpdates(): Promise<Match[]> {
    return [];
  }

  async fetchPlayerMatchStats(_matchId: string): Promise<PlayerMatchStat[]> {
    return [];
  }
}
