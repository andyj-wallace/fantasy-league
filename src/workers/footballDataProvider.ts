import type { PlayerPosition } from "../domain";

/**
 * Boundary between our system and an external football data source (currently API-Football,
 * v3.football.api-sports.io). Every method returns provider-shaped data, not our domain types —
 * resolving a provider fixture/player into our internal Match/Player rows (externalId lookups,
 * Gameweek bootstrap, etc.) is the importer workers' job, not this boundary's.
 */
export interface ProviderFixture {
  externalId: string;
  /** Raw round label, e.g. "Regular Season - 14" — parsed into a Gameweek number by the importer. */
  roundLabel: string;
  homeClub: string;
  awayClub: string;
  kickoffAt: Date;
  /** Provider's short status code (NS, 1H, FT, PST, ...) — mapped to MatchStatus by the importer. */
  statusShortCode: string;
  finalHomeScore: number | null;
  finalAwayScore: number | null;
}

export interface ProviderPlayerMatchStat {
  externalPlayerId: string;
  minutesPlayed: number;
  goalsScored: number;
  assists: number;
  savesCount: number;
  ownGoalsScored: number;
  penaltiesWon: number;
  penaltiesConceded: number;
  receivedYellowCard: boolean;
  receivedRedCard: boolean;
}

export interface ProviderRosterEntry {
  externalId: string;
  name: string;
  club: string;
  position: PlayerPosition;
}

export interface ProviderInjuryEntry {
  externalPlayerId: string;
  /** "Missing Fixture" | "Questionable" per the provider's two-value type field. */
  type: string;
  reason: string | null;
}

export interface QuotaStatus {
  requestsUsedToday: number;
  requestsLimitPerDay: number;
}

export interface FootballDataProvider {
  /** ~1 call/gameweek: full season fixture list, including kickoff times — rarely changes outside a postponement. */
  fetchSeasonFixtures(): Promise<ProviderFixture[]>;
  /** 1 call: broad status-only list of every fixture currently in play. */
  fetchLiveFixtures(): Promise<ProviderFixture[]>;
  /** 2 calls (events + players) for one fixture. */
  fetchFixturePlayerStats(externalFixtureId: string): Promise<ProviderPlayerMatchStat[]>;
  /** ~21 calls (1 /teams + 20 /players/squads): current squads only, no pagination — cheap, but
   * misses new signings/promoted-club players not yet linked to a squad block. */
  fetchPlayerRoster(): Promise<ProviderRosterEntry[]>;
  /** Paginated full-league pull (/players?league&season&page, ~28 calls for a season) — the
   * complete player list, including anyone fetchPlayerRoster's squad snapshot misses. Costlier
   * and rate-limited (inter-page delay), so this is for one-time hydration and monthly syncs,
   * not the frequent roster check. */
  fetchAllPlayersForSeason(): Promise<ProviderRosterEntry[]>;
  /** Today's injury/suspension report for the whole league. */
  fetchInjuries(): Promise<ProviderInjuryEntry[]>;
  /** Free call (per polling-budget.md) — today's remaining request budget. */
  fetchQuotaStatus(): Promise<QuotaStatus>;
}

export class StubFootballDataProvider implements FootballDataProvider {
  async fetchSeasonFixtures(): Promise<ProviderFixture[]> {
    return [];
  }

  async fetchLiveFixtures(): Promise<ProviderFixture[]> {
    return [];
  }

  async fetchFixturePlayerStats(_externalFixtureId: string): Promise<ProviderPlayerMatchStat[]> {
    return [];
  }

  async fetchPlayerRoster(): Promise<ProviderRosterEntry[]> {
    return [];
  }

  async fetchAllPlayersForSeason(): Promise<ProviderRosterEntry[]> {
    return [];
  }

  async fetchInjuries(): Promise<ProviderInjuryEntry[]> {
    return [];
  }

  async fetchQuotaStatus(): Promise<QuotaStatus> {
    return { requestsUsedToday: 0, requestsLimitPerDay: 100 };
  }
}
