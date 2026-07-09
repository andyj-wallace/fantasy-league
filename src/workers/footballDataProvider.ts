import type { PlayerPosition, PlayerProfile, PlayerSeasonStatistics } from "../domain";

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

export interface ProviderSeasonInfo {
  seasonYear: number;
  /** Whether the provider currently has per-player stats for completed fixtures (`fixtures/players` endpoint). */
  coverageFixturePlayerStats: boolean;
  /** Whether the provider currently has injury/suspension data for the season (`injuries` endpoint). */
  coverageInjuries: boolean;
}

export interface FootballDataProvider {
  /** Push the active season year and coverage flags into the provider after they are resolved from
   * the DB (monthly sync). Methods that are ungated for this season become no-ops. */
  setCurrentSeason(year: number, coverage: { fixturePlayerStats: boolean; injuries: boolean }): void;
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
  /** Today's remaining request budget. Served from the rate-limit headers of the most recent
   * response when one was observed this UTC day (zero calls); falls back to the free /status
   * call otherwise (per polling-budget.md). */
  fetchQuotaStatus(): Promise<QuotaStatus>;
  /** Monthly: resolves the current PL season year and what data is actually covered by the provider
   * for that season. Drives setCurrentSeason — null means provider unreachable, keep existing. */
  fetchLeagueCurrentSeason(): Promise<ProviderSeasonInfo | null>;
  /** Bio/photo detail for the player-detail page. Fetched live on each request — this is
   * presentational data outside the scoring pipeline, so unlike the methods above it has no
   * importer worker and nothing is persisted from it. */
  fetchPlayerProfile(externalPlayerId: string): Promise<PlayerProfile | null>;
  /** One season's aggregated stat line for the player-detail page. Same live, not-persisted
   * rationale as fetchPlayerProfile. */
  fetchPlayerSeasonStatistics(externalPlayerId: string, season: number): Promise<PlayerSeasonStatistics | null>;
}

export class StubFootballDataProvider implements FootballDataProvider {
  setCurrentSeason(_year: number, _coverage: { fixturePlayerStats: boolean; injuries: boolean }): void {}

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

  async fetchPlayerProfile(_externalPlayerId: string): Promise<PlayerProfile | null> {
    return null;
  }

  async fetchPlayerSeasonStatistics(_externalPlayerId: string, _season: number): Promise<PlayerSeasonStatistics | null> {
    return null;
  }

  async fetchLeagueCurrentSeason(): Promise<ProviderSeasonInfo | null> {
    return null;
  }
}
