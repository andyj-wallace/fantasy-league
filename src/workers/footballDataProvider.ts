import type { GoalType, PlayerPosition, PlayerProfile, PlayerSeasonStatistics } from "../domain";

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
  wasInStartingLineup: boolean;
}

/** One goal off the provider's fixture event feed. beneficiaryClub is already own-goal
 * normalized by the provider implementation, so importers never redo that reasoning. */
export interface ProviderGoalEvent {
  externalScorerPlayerId: string | null;
  externalAssistPlayerId: string | null;
  beneficiaryClub: string;
  goalType: GoalType;
  elapsedMinute: number;
  addedTimeMinute: number;
  sequenceIndex: number;
}

/** Everything one fixture-detail poll yields. The two halves travel together because they come
 * from a single parallel fixtures/players + fixtures/events pair — splitting them into separate
 * provider methods would double the per-fixture request cost (see docs/polling-budget.md). */
export interface ProviderFixtureDetail {
  playerStats: ProviderPlayerMatchStat[];
  goalEvents: ProviderGoalEvent[];
}

export interface ProviderRosterEntry {
  externalId: string;
  name: string;
  club: string;
  position: PlayerPosition;
}

/** One club in the league, as the provider identifies it. */
export interface ProviderLeagueTeam {
  externalId: string;
  name: string;
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
  /** Whether the provider currently has the season's league-wide player list (`players?league&season`).
   * Split out from the fixture-stats flag because the two genuinely diverge: season 2026 served
   * `/teams` and `/players/squads` correctly while `/players?league=39&season=2026` returned zero
   * results, so a caller must ask about the endpoint it is actually going to call. */
  coveragePlayers: boolean;
  /** Whether the provider currently has injury/suspension data for the season (`injuries` endpoint). */
  coverageInjuries: boolean;
}

/** One season of the league as the provider holds it, with what it covers. */
export interface ProviderLeagueSeason extends ProviderSeasonInfo {
  isCurrentSeason: boolean;
}

/** API-Football accepts at most 20 fixture ids in one `ids=a-b-c` request. It lives on the
 * boundary rather than inside the HTTP implementation because callers budget their request count
 * against it (see the reconciliation cost in docs/polling-budget.md). */
export const MAX_FIXTURE_IDS_PER_PROVIDER_REQUEST = 20;

export interface FootballDataProvider {
  /** Push the active season year and coverage flags into the provider after they are resolved from
   * the DB (monthly sync). Methods that are ungated for this season become no-ops. */
  setCurrentSeason(year: number, coverage: { fixturePlayerStats: boolean; injuries: boolean }): void;
  /** ~1 call/gameweek: full season fixture list, including kickoff times — rarely changes outside a postponement. */
  fetchSeasonFixtures(): Promise<ProviderFixture[]>;
  /** 1 call: broad status-only list of every fixture currently in play. */
  fetchLiveFixtures(): Promise<ProviderFixture[]>;
  /** 1 call per MAX_FIXTURE_IDS_PER_PROVIDER_REQUEST ids: current state of explicitly named
   * fixtures. Unlike the live list this reports terminal statuses (FT/PST/ABD), which is what
   * makes it the only way to observe a fixture that ended: the final whistle *removes* a fixture
   * from `live=all` rather than reporting it as FT, so a match still IN_PROGRESS on our side and
   * absent from that list can only be resolved by asking about it by id. See
   * docs/stuck-live-match-reconciliation-plan.md. */
  fetchFixturesByExternalIds(externalFixtureIds: string[]): Promise<ProviderFixture[]>;
  /** 2 calls (events + players) for one fixture. */
  fetchFixturePlayerStatsAndGoalEvents(externalFixtureId: string): Promise<ProviderFixtureDetail>;
  /** ~21 calls (1 /teams + 20 /players/squads): current squads only, no pagination — cheap, but
   * misses new signings/promoted-club players not yet linked to a squad block. */
  fetchPlayerRoster(): Promise<ProviderRosterEntry[]>;
  /** Paginated full-league pull (/players?league&season&page, ~28 calls for a season) — the
   * complete player list, including anyone fetchPlayerRoster's squad snapshot misses. Costlier
   * and rate-limited (inter-page delay), so this is for one-time hydration and monthly syncs,
   * not the frequent roster check. */
  fetchAllPlayersForSeason(): Promise<ProviderRosterEntry[]>;
  /** Same paginated /players?league&season&page pull as fetchAllPlayersForSeason, but for an
   * arbitrary season (not pinned to the season set via setCurrentSeason) and reading each
   * player's full aggregate stat line instead of just identity — used by the one-time initial
   * player pricing hydration to pull a *previous* season's stats. */
  fetchAllPlayerSeasonStatistics(season: number): Promise<PlayerSeasonStatistics[]>;
  /** Today's injury/suspension report for the whole league. */
  fetchInjuries(): Promise<ProviderInjuryEntry[]>;
  /** Today's remaining request budget. Served from the rate-limit headers of the most recent
   * response when one was observed this UTC day (zero calls); falls back to the free /status
   * call otherwise (per polling-budget.md). */
  fetchQuotaStatus(): Promise<QuotaStatus>;
  /** Monthly: resolves the current PL season year and what data is actually covered by the provider
   * for that season. Drives setCurrentSeason — null means provider unreachable, keep existing. */
  fetchLeagueCurrentSeason(): Promise<ProviderSeasonInfo | null>;
  /** Every season of the league the provider holds, with coverage flags and which one is current —
   * the same single /leagues call fetchLeagueCurrentSeason makes, read across all seasons. A
   * hydration run deliberately pointed at a completed season needs *that* season's coverage flags,
   * which the current-season answer cannot give it. */
  fetchLeagueSeasons(): Promise<ProviderLeagueSeason[]>;
  /** Bio/photo detail for the player-detail page. Fetched live on each request — this is
   * presentational data outside the scoring pipeline, so unlike the methods above it has no
   * importer worker and nothing is persisted from it. */
  fetchPlayerProfile(externalPlayerId: string): Promise<PlayerProfile | null>;
  /** One season's aggregated stat line for the player-detail page. Same live, not-persisted
   * rationale as fetchPlayerProfile. */
  fetchPlayerSeasonStatistics(externalPlayerId: string, season: number): Promise<PlayerSeasonStatistics | null>;
  /** Every competition the player appeared in that season — one entry per competition, sharing an
   * externalId. Unlike fetchPlayerSeasonStatistics this makes no guess about which one matters;
   * pricing a player who arrived from outside the Premier League needs the whole list so it can
   * pick his primary domestic league (see domain/leagueStrength.ts). */
  fetchPlayerSeasonStatisticsAcrossCompetitions(externalPlayerId: string, season: number): Promise<PlayerSeasonStatistics[]>;
  /** Every competition entry for every player who appeared for one club that season. The bulk
   * alternative to a per-player lookup when many new signings share a former club — a club is
   * ~2 pages where a whole league is ~48. */
  fetchTeamPlayerSeasonStatistics(externalTeamId: string, season: number): Promise<PlayerSeasonStatistics[]>;
  /** Ids of every competition the provider classifies as a domestic league, so cups and
   * international tournaments can be excluded when picking a stat line to price from. One call;
   * stable enough to cache across runs. */
  fetchDomesticLeagueIds(): Promise<Set<number>>;
  /** The league's clubs for a season, as id/name pairs — Player rows carry only a club name, so
   * grouping players by club for a per-club bulk pull needs this mapping. */
  fetchLeagueTeams(season: number): Promise<ProviderLeagueTeam[]>;
}

export class StubFootballDataProvider implements FootballDataProvider {
  setCurrentSeason(_year: number, _coverage: { fixturePlayerStats: boolean; injuries: boolean }): void {}

  async fetchSeasonFixtures(): Promise<ProviderFixture[]> {
    return [];
  }

  async fetchLiveFixtures(): Promise<ProviderFixture[]> {
    return [];
  }

  async fetchFixturesByExternalIds(_externalFixtureIds: string[]): Promise<ProviderFixture[]> {
    return [];
  }

  async fetchFixturePlayerStatsAndGoalEvents(_externalFixtureId: string): Promise<ProviderFixtureDetail> {
    return { playerStats: [], goalEvents: [] };
  }

  async fetchPlayerRoster(): Promise<ProviderRosterEntry[]> {
    return [];
  }

  async fetchAllPlayersForSeason(): Promise<ProviderRosterEntry[]> {
    return [];
  }

  async fetchAllPlayerSeasonStatistics(_season: number): Promise<PlayerSeasonStatistics[]> {
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

  async fetchPlayerSeasonStatisticsAcrossCompetitions(
    _externalPlayerId: string,
    _season: number,
  ): Promise<PlayerSeasonStatistics[]> {
    return [];
  }

  async fetchTeamPlayerSeasonStatistics(_externalTeamId: string, _season: number): Promise<PlayerSeasonStatistics[]> {
    return [];
  }

  async fetchDomesticLeagueIds(): Promise<Set<number>> {
    return new Set();
  }

  async fetchLeagueTeams(_season: number): Promise<ProviderLeagueTeam[]> {
    return [];
  }

  async fetchLeagueCurrentSeason(): Promise<ProviderSeasonInfo | null> {
    return null;
  }

  async fetchLeagueSeasons(): Promise<ProviderLeagueSeason[]> {
    return [];
  }
}
