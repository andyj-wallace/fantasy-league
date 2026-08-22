import { PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID } from "../domain";
import type { PlayerPosition, PlayerProfile, PlayerSeasonStatistics } from "../domain";
import { MAX_FIXTURE_IDS_PER_PROVIDER_REQUEST } from "./footballDataProvider";
import type {
  FootballDataProvider,
  ProviderFixture,
  ProviderFixtureDetail,
  ProviderGoalEvent,
  ProviderInjuryEntry,
  ProviderLeagueSeason,
  ProviderLeagueTeam,
  ProviderPlayerMatchStat,
  ProviderRosterEntry,
  ProviderSeasonInfo,
  QuotaStatus,
} from "./footballDataProvider";

/** Premier League's API-Football league ID. */
const PREMIER_LEAGUE_ID = PREMIER_LEAGUE_EXTERNAL_LEAGUE_ID;

/** Inter-request delay for loops that issue several calls back to back (one /players/squads
 * call per club, one /players call per page) — lower API-Football plan tiers (including Free)
 * rate-limit per minute well below what a tight loop of ~20 calls produces with no delay at all,
 * so both loops below pace themselves against this. Configurable since the right value depends
 * on plan tier; default errs conservative since hitting it means a wasted, partially-completed
 * run. With header-driven per-minute pacing now in request() as well, this fixed delay is the
 * floor for cold starts and header-less providers — a candidate to tune down once the header
 * pacing has been observed working against the live API. */
const INTER_REQUEST_DELAY_MS = Number(process.env.FOOTBALL_DATA_REQUEST_DELAY_MS ?? 7_000);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** API-Football appends these rate-limit headers to every response. The "requests" pair tracks
 * the daily subscription quota; the bare pair tracks the per-minute call cap. Header lookup via
 * Headers.get() is case-insensitive, so the documented mixed-case forms match these too. */
const API_SPORTS_DAILY_LIMIT_HEADER = "x-ratelimit-requests-limit";
const API_SPORTS_DAILY_REMAINING_HEADER = "x-ratelimit-requests-remaining";
const API_SPORTS_PER_MINUTE_LIMIT_HEADER = "x-ratelimit-limit";
const API_SPORTS_PER_MINUTE_REMAINING_HEADER = "x-ratelimit-remaining";

const PER_MINUTE_WINDOW_MS = 60_000;
/** Padding added when waiting out the per-minute window, since we only know when we *observed*
 * the exhausted counter, not when the provider's window actually started. */
const PER_MINUTE_WINDOW_RESET_BUFFER_MS = 2_000;
/** Dispatch is paused while the observed per-minute remaining is at or below this. One (not
 * zero) so the concurrent pair in fetchFixturePlayerStatsAndGoalEvents can't race past an
 * almost-spent window between snapshot reads. */
const PER_MINUTE_REMAINING_RESERVE = 1;
/** Upper bound on the single 429 retry wait — a full per-minute window plus buffer. */
const MAX_RATE_LIMITED_RETRY_WAIT_MS = 65_000;
/** Upper bound when a 429's Retry-After header names the wait itself — the server's answer is
 * better than our window estimate, but never trust a header into an unbounded sleep. */
const MAX_RETRY_AFTER_WAIT_MS = 120_000;

/** The rate-limit state observed on the most recent real HTTP response. Null until the first
 * response lands (and forever null in the offline/in-memory providers, which replace request()
 * wholesale) — every consumer treats a missing snapshot as "no information, change nothing". */
interface ProviderRateLimitSnapshot {
  dailyRequestLimit: number | null;
  dailyRequestsRemaining: number | null;
  perMinuteRequestLimit: number | null;
  perMinuteRequestsRemaining: number | null;
  observedAt: Date;
}

function parseNumericHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The delay-seconds form of a 429's Retry-After header, in milliseconds. Null for a missing
 * header, garbage, or the rare HTTP-date form — callers fall back to the per-minute window
 * estimate in those cases. */
function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1_000;
}

/** The provider's daily quota resets at UTC midnight, so a snapshot is only trustworthy for
 * daily-quota purposes within the UTC calendar day it was observed in. */
function isSameUtcCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

const POSITION_BY_PROVIDER_LABEL: Record<string, PlayerPosition> = {
  Goalkeeper: "GK",
  Defender: "DEF",
  Midfielder: "MID",
  Attacker: "FWD",
};

function mapProviderPositionLabel(label: string | null | undefined): PlayerPosition | null {
  if (!label) return null;
  return POSITION_BY_PROVIDER_LABEL[label] ?? null;
}

export interface ApiFootballEnvelope<T> {
  response: T;
  errors: unknown;
  paging?: { current: number; total: number };
}

/** Raw shapes lifted from API-Football v3's documented response bodies — only the fields we use. */
interface RawFixture {
  fixture: { id: number; date: string; status: { short: string } };
  league: { round: string };
  teams: { home: { name: string }; away: { name: string } };
  goals: { home: number | null; away: number | null };
}

interface RawFixtureEvent {
  type: string;
  detail: string;
  time: { elapsed: number | null; extra: number | null };
  team: { name: string };
  player: { id: number | null; name: string | null };
  assist: { id: number | null; name: string | null };
}

interface RawFixturePlayerStatistics {
  games: { minutes: number | null; substitute: boolean | null };
  goals: { total: number | null; assists: number | null; saves: number | null };
  cards: { yellow: number | null; red: number | null };
  penalty: { won: number | null; commited?: number | null; committed?: number | null };
}

interface RawFixturePlayersBlock {
  team: { name: string };
  players: { player: { id: number }; statistics: RawFixturePlayerStatistics[] }[];
}

interface RawTeam {
  team: { id: number; name: string };
}

/** /players/squads returns position as a direct full-word field per player — distinct from
 * fixtures/players' single-letter games.position. /players' paginated season-stats shape uses
 * this same full-word convention (via games.position below), just nested under statistics[]. */
interface RawSquadBlock {
  team: { id: number; name: string };
  players: { id: number; name: string; position: string | null }[];
}

interface RawInjuryEntry {
  player: { id: number; type: string; reason: string | null };
}

interface RawStatusResponse {
  requests: { current: number; limit_day: number };
}

interface RawLeagueSeasonEntry {
  year: number;
  current: boolean;
  coverage: {
    players: boolean;
    fixtures: { statistics_players: boolean };
    injuries: boolean;
  };
}

interface RawLeagueEntry {
  seasons: RawLeagueSeasonEntry[];
}

/** /leagues?type=league — identity only; the season/coverage blocks are ignored here. */
interface RawLeagueTypeEntry {
  league: { id: number | null };
}

/** /players/profiles' single-player bio response. */
interface RawPlayerProfileEntry {
  player: {
    id: number;
    firstname: string | null;
    lastname: string | null;
    age: number | null;
    birth: { date: string | null; place: string | null; country: string | null };
    nationality: string | null;
    height: string | null;
    weight: string | null;
    number: number | null;
    photo: string | null;
  };
}

/** /players' response shape — shared by the single-player-and-season lookup
 * (fetchPlayerSeasonStatistics), the paginated current-roster pull (fetchAllPlayersForSeason),
 * and the paginated previous-season stats pull (fetchAllPlayerSeasonStatistics): same underlying
 * API shape, read for different fields depending on the caller. A player transferred mid-season
 * has multiple statistics[] entries; every caller here uses only the first (primary club for the
 * requested season). */
interface RawPlayerStatisticsEntry {
  player: { id: number; name: string };
  statistics: {
    team: { name: string };
    league: { id: number | null; name: string };
    games: { appearences: number | null; minutes: number | null; position: string | null; rating: string | null };
    goals: { total: number | null; assists: number | null; saves: number | null };
    cards: { yellow: number | null; red: number | null };
  }[];
}

type RawStatisticsBlock = RawPlayerStatisticsEntry["statistics"][number];

/** Maps one competition's statistics block into PlayerSeasonStatistics. */
function toPlayerSeasonStatisticsFromBlock(
  player: RawPlayerStatisticsEntry["player"],
  statistics: RawStatisticsBlock,
  season: number,
): PlayerSeasonStatistics {
  return {
    externalId: String(player.id),
    season,
    club: statistics.team.name,
    leagueName: statistics.league.name,
    leagueId: statistics.league.id,
    position: mapProviderPositionLabel(statistics.games.position),
    appearances: statistics.games.appearences ?? 0,
    minutesPlayed: statistics.games.minutes ?? 0,
    rating: statistics.games.rating ? Number(statistics.games.rating) : null,
    goals: statistics.goals.total ?? 0,
    assists: statistics.goals.assists ?? 0,
    saves: statistics.goals.saves ?? 0,
    yellowCards: statistics.cards.yellow ?? 0,
    redCards: statistics.cards.red ?? 0,
  };
}

/** Maps a RawPlayerStatisticsEntry's first statistics block into PlayerSeasonStatistics — null
 * when the player has no statistics entry for the requested season at all.
 *
 * "First" is only meaningful for a league-scoped request, where every block belongs to the league
 * asked for. On an unscoped single-player request the blocks span every competition in arbitrary
 * order, and the caller wants toAllPlayerSeasonStatistics + selectPrimaryDomesticLeagueEntry
 * instead. */
function toPlayerSeasonStatistics(entry: RawPlayerStatisticsEntry, season: number): PlayerSeasonStatistics | null {
  const statistics = entry.statistics[0];
  if (!statistics) return null;
  return toPlayerSeasonStatisticsFromBlock(entry.player, statistics, season);
}

/** Every competition the player appeared in that season, one PlayerSeasonStatistics per block.
 * Entries share an externalId — the caller groups and picks (see selectPrimaryDomesticLeagueEntry). */
function toAllPlayerSeasonStatistics(entry: RawPlayerStatisticsEntry, season: number): PlayerSeasonStatistics[] {
  return entry.statistics.map((statistics) => toPlayerSeasonStatisticsFromBlock(entry.player, statistics, season));
}

/** Parses API-Football's "175 cm" / "68 kg" string fields down to a bare number. */
function parseLeadingNumber(value: string | null): number | null {
  if (!value) return null;
  const match = /^\d+/.exec(value);
  return match ? Number(match[0]) : null;
}

function toProviderFixture(raw: RawFixture): ProviderFixture {
  return {
    externalId: String(raw.fixture.id),
    roundLabel: raw.league.round,
    homeClub: raw.teams.home.name,
    awayClub: raw.teams.away.name,
    kickoffAt: new Date(raw.fixture.date),
    statusShortCode: raw.fixture.status.short,
    finalHomeScore: raw.goals.home,
    finalAwayScore: raw.goals.away,
  };
}

export class ApiFootballProvider implements FootballDataProvider {
  private seasonYear: number;
  private coverageFixturePlayerStats = false;
  private coverageInjuries = false;
  private latestRateLimitSnapshot: ProviderRateLimitSnapshot | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    initialSeasonYear: number,
  ) {
    this.seasonYear = initialSeasonYear;
  }

  setCurrentSeason(year: number, coverage: { fixturePlayerStats: boolean; injuries: boolean }): void {
    this.seasonYear = year;
    this.coverageFixturePlayerStats = coverage.fixturePlayerStats;
    this.coverageInjuries = coverage.injuries;
  }

  /** The single HTTP entry point every fetch method funnels through — protected so the offline
   * and recording providers can substitute recorded response envelopes for the network. Paces
   * itself against the per-minute rate limit observed on previous responses, and retries once
   * (after waiting out the minute window) on a 429 — a second 429 fails like any other error. */
  protected async request<T>(path: string, params: Record<string, string | number> = {}): Promise<ApiFootballEnvelope<T>> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    await this.waitOutPerMinuteRateLimitWindowIfNearlyExhausted();
    let res = await this.dispatchRequestAndCaptureRateLimitHeaders(url);

    // A per-minute-cap 429 is recoverable by waiting for the window; a daily-cap 429 is not, so
    // don't burn a minute sleeping when the 429's own headers show the day's quota is spent.
    // Prefer the server's own Retry-After answer over our window estimate when it sends one.
    if (res.status === 429 && this.latestRateLimitSnapshot?.dailyRequestsRemaining !== 0) {
      const retryAfterMs = parseRetryAfterMs(res.headers);
      const retryWaitMs =
        retryAfterMs !== null
          ? Math.min(MAX_RETRY_AFTER_WAIT_MS, retryAfterMs)
          : Math.min(MAX_RATE_LIMITED_RETRY_WAIT_MS, this.millisecondsUntilPerMinuteWindowLikelyResets());
      console.warn(`[provider] 429 rate-limited on ${path} — waiting ${retryWaitMs}ms for the per-minute window, then retrying once`);
      await delay(retryWaitMs);
      res = await this.dispatchRequestAndCaptureRateLimitHeaders(url);
    }

    if (!res.ok) {
      throw new Error(`API-Football request failed: ${res.status} ${res.statusText} (${path})`);
    }

    const body = (await res.json()) as ApiFootballEnvelope<T>;
    const errorCount = Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors ?? {}).length;
    if (errorCount > 0) {
      throw new Error(`API-Football returned errors for ${path}: ${JSON.stringify(body.errors)}`);
    }

    return body;
  }

  private async dispatchRequestAndCaptureRateLimitHeaders(url: URL): Promise<Response> {
    const snapshot = this.latestRateLimitSnapshot;
    if (snapshot?.perMinuteRequestsRemaining != null) {
      // Optimistic pre-decrement so concurrent callers (the Promise.all pair in
      // fetchFixturePlayerStatsAndGoalEvents) see this dispatch before its response headers land.
      snapshot.perMinuteRequestsRemaining = Math.max(0, snapshot.perMinuteRequestsRemaining - 1);
    }
    const res = await fetch(url, { headers: { "x-apisports-key": this.apiKey } });
    this.captureRateLimitSnapshotFromResponseHeaders(res.headers);
    return res;
  }

  private captureRateLimitSnapshotFromResponseHeaders(headers: Headers): void {
    const snapshot: ProviderRateLimitSnapshot = {
      dailyRequestLimit: parseNumericHeader(headers, API_SPORTS_DAILY_LIMIT_HEADER),
      dailyRequestsRemaining: parseNumericHeader(headers, API_SPORTS_DAILY_REMAINING_HEADER),
      perMinuteRequestLimit: parseNumericHeader(headers, API_SPORTS_PER_MINUTE_LIMIT_HEADER),
      perMinuteRequestsRemaining: parseNumericHeader(headers, API_SPORTS_PER_MINUTE_REMAINING_HEADER),
      observedAt: new Date(),
    };
    const parsedAnyHeader =
      snapshot.dailyRequestLimit !== null ||
      snapshot.dailyRequestsRemaining !== null ||
      snapshot.perMinuteRequestLimit !== null ||
      snapshot.perMinuteRequestsRemaining !== null;
    // A header-less response (stripping proxy, unexpected error page) must not wipe out a good
    // snapshot from the previous response.
    if (parsedAnyHeader) this.latestRateLimitSnapshot = snapshot;
  }

  private millisecondsUntilPerMinuteWindowLikelyResets(): number {
    const snapshot = this.latestRateLimitSnapshot;
    if (!snapshot || snapshot.perMinuteRequestsRemaining == null) {
      return PER_MINUTE_WINDOW_MS + PER_MINUTE_WINDOW_RESET_BUFFER_MS;
    }
    const elapsedMs = Date.now() - snapshot.observedAt.getTime();
    return Math.max(0, PER_MINUTE_WINDOW_MS - elapsedMs + PER_MINUTE_WINDOW_RESET_BUFFER_MS);
  }

  private async waitOutPerMinuteRateLimitWindowIfNearlyExhausted(): Promise<void> {
    const snapshot = this.latestRateLimitSnapshot;
    if (!snapshot || snapshot.perMinuteRequestsRemaining == null) return;
    if (snapshot.perMinuteRequestsRemaining > PER_MINUTE_REMAINING_RESERVE) return;
    const elapsedMs = Date.now() - snapshot.observedAt.getTime();
    if (elapsedMs >= PER_MINUTE_WINDOW_MS) return; // the observed window has already rolled over
    const waitMs = PER_MINUTE_WINDOW_MS - elapsedMs + PER_MINUTE_WINDOW_RESET_BUFFER_MS;
    console.warn(
      `[provider] per-minute rate limit nearly exhausted (${snapshot.perMinuteRequestsRemaining} remaining) — waiting ${waitMs}ms for the window to reset`,
    );
    await delay(waitMs);
  }

  /** Daily quota derived from the most recent response's rate-limit headers, or null when no
   * usable snapshot exists (no real call yet, header-less provider) or the snapshot predates
   * today's UTC-midnight quota reset. Within the same UTC day a snapshot is exact, not merely
   * fresh — this process is the only consumer of the key, so the counter only moves via our own
   * calls. */
  private quotaStatusFromRateLimitSnapshotObservedToday(): QuotaStatus | null {
    const snapshot = this.latestRateLimitSnapshot;
    if (!snapshot || snapshot.dailyRequestLimit === null || snapshot.dailyRequestsRemaining === null) return null;
    if (!isSameUtcCalendarDay(snapshot.observedAt, new Date())) return null;
    return {
      requestsUsedToday: snapshot.dailyRequestLimit - snapshot.dailyRequestsRemaining,
      requestsLimitPerDay: snapshot.dailyRequestLimit,
    };
  }

  async fetchSeasonFixtures(): Promise<ProviderFixture[]> {
    const { response } = await this.request<RawFixture[]>("fixtures", {
      league: PREMIER_LEAGUE_ID,
      season: this.seasonYear,
    });
    return response.map(toProviderFixture);
  }

  async fetchLiveFixtures(): Promise<ProviderFixture[]> {
    // `live=all` is inherently scoped to fixtures happening right now, so `season` isn't
    // accepted/needed here the way it is for the season-fixture-list and stats endpoints —
    // just `league` to keep it to the Premier League.
    const { response } = await this.request<RawFixture[]>("fixtures", {
      league: PREMIER_LEAGUE_ID,
      live: "all",
    });
    return response.map(toProviderFixture);
  }

  async fetchFixturesByExternalIds(externalFixtureIds: string[]): Promise<ProviderFixture[]> {
    // `ids` is self-scoping — the fixtures are named outright — so this call takes neither
    // `league` nor `season`, and an empty list must cost nothing rather than degrade into an
    // unfiltered fixtures query.
    const deduplicatedExternalFixtureIds = [...new Set(externalFixtureIds)];
    const fixtures: ProviderFixture[] = [];
    for (
      let batchStartIndex = 0;
      batchStartIndex < deduplicatedExternalFixtureIds.length;
      batchStartIndex += MAX_FIXTURE_IDS_PER_PROVIDER_REQUEST
    ) {
      const batchedExternalFixtureIds = deduplicatedExternalFixtureIds.slice(
        batchStartIndex,
        batchStartIndex + MAX_FIXTURE_IDS_PER_PROVIDER_REQUEST,
      );
      const { response } = await this.request<RawFixture[]>("fixtures", { ids: batchedExternalFixtureIds.join("-") });
      fixtures.push(...response.map(toProviderFixture));
    }
    return fixtures;
  }

  async fetchFixturePlayerStatsAndGoalEvents(externalFixtureId: string): Promise<ProviderFixtureDetail> {
    if (!this.coverageFixturePlayerStats) {
      console.log(
        `[provider] fetchFixturePlayerStatsAndGoalEvents skipped — statistics_players not covered for season ${this.seasonYear}`,
      );
      return { playerStats: [], goalEvents: [] };
    }
    const [playersResult, eventsResult] = await Promise.all([
      this.request<RawFixturePlayersBlock[]>("fixtures/players", { fixture: externalFixtureId }),
      this.request<RawFixtureEvent[]>("fixtures/events", { fixture: externalFixtureId }),
    ]);

    const ownGoalsByExternalPlayerId = new Map<string, number>();
    for (const event of eventsResult.response) {
      if (event.type === "Goal" && event.detail === "Own Goal" && event.player.id != null) {
        const externalPlayerId = String(event.player.id);
        ownGoalsByExternalPlayerId.set(externalPlayerId, (ownGoalsByExternalPlayerId.get(externalPlayerId) ?? 0) + 1);
      }
    }

    // The provider credits an own goal to the scorer's own club; the goal counts for the other
    // one. Normalizing here keeps every downstream consumer free of the special case.
    const clubNamesInFixture = playersResult.response.map((teamBlock) => teamBlock.team.name);
    const goalEvents: ProviderGoalEvent[] = [];
    for (const [eventIndex, event] of eventsResult.response.entries()) {
      // "Missed Penalty" arrives as type "Goal" in this feed, but it is neither a PENALTY goal nor
      // a change to the scoreline — including it would corrupt the running scoreline walk.
      if (event.type !== "Goal" || event.detail === "Missed Penalty") continue;
      const isOwnGoal = event.detail === "Own Goal";
      const opposingClubName = clubNamesInFixture.find((clubName) => clubName !== event.team.name);
      const beneficiaryClub = isOwnGoal ? (opposingClubName ?? event.team.name) : event.team.name;
      goalEvents.push({
        externalScorerPlayerId: event.player.id == null ? null : String(event.player.id),
        externalAssistPlayerId: isOwnGoal || event.assist.id == null ? null : String(event.assist.id),
        beneficiaryClub,
        goalType: isOwnGoal ? "OWN_GOAL" : event.detail === "Penalty" ? "PENALTY" : "NORMAL",
        elapsedMinute: event.time.elapsed ?? 0,
        addedTimeMinute: event.time.extra ?? 0,
        sequenceIndex: eventIndex,
      });
    }

    const playerStats: ProviderPlayerMatchStat[] = [];
    for (const teamBlock of playersResult.response) {
      for (const playerBlock of teamBlock.players) {
        const statistics = playerBlock.statistics[0];
        if (!statistics) continue;

        const externalPlayerId = String(playerBlock.player.id);
        playerStats.push({
          externalPlayerId,
          minutesPlayed: statistics.games.minutes ?? 0,
          goalsScored: statistics.goals.total ?? 0,
          assists: statistics.goals.assists ?? 0,
          savesCount: statistics.goals.saves ?? 0,
          ownGoalsScored: ownGoalsByExternalPlayerId.get(externalPlayerId) ?? 0,
          penaltiesWon: statistics.penalty.won ?? 0,
          // API-Football's documented field is the misspelled "commited" (one T); fall back to
          // the correctly-spelled name in case they ever fix it.
          penaltiesConceded: statistics.penalty.commited ?? statistics.penalty.committed ?? 0,
          receivedYellowCard: (statistics.cards.yellow ?? 0) > 0,
          receivedRedCard: (statistics.cards.red ?? 0) > 0,
          // Strictly `=== false`: an absent or null flag is unknown, not "started".
          wasInStartingLineup: statistics.games.substitute === false,
        });
      }
    }
    return { playerStats, goalEvents };
  }

  /** One call to enumerate the league's 20 clubs, then one /players/squads call per club — no
   * pagination, and position comes back as the full word directly on each player. Costlier than
   * a single call, so this is gated to run weekly rather than daily (see runWorkerCycle.ts). */
  async fetchPlayerRoster(): Promise<ProviderRosterEntry[]> {
    const { response: teams } = await this.request<RawTeam[]>("teams", {
      league: PREMIER_LEAGUE_ID,
      season: this.seasonYear,
    });

    const entries: ProviderRosterEntry[] = [];
    for (const teamEntry of teams) {
      await delay(INTER_REQUEST_DELAY_MS);
      const { response: squadBlocks } = await this.request<RawSquadBlock[]>("players/squads", {
        team: teamEntry.team.id,
      });

      for (const squadBlock of squadBlocks) {
        for (const player of squadBlock.players) {
          const position = mapProviderPositionLabel(player.position);
          if (!position) continue; // skip entries with no usable position (e.g. provider data gaps)
          entries.push({
            externalId: String(player.id),
            name: player.name,
            club: squadBlock.team.name,
            position,
          });
        }
      }
    }
    return entries;
  }

  /** Shared /players?league&season&page pagination loop — season is an explicit argument, never
   * `this.seasonYear`, so the same loop serves both the current-season roster pull and an
   * arbitrary-season stats pull off one provider instance. Delays between pages
   * (INTER_REQUEST_DELAY_MS) to stay under the provider's per-minute rate limit; a full season is
   * ~28 pages, so this is for one-time hydration and monthly syncs, not a frequent check.
   *
   * Lower API-Football plan tiers (including Free) cap the `page` param itself — e.g. "Free
   * plans are limited to a maximum value of 3 for the Page parameter" — well below the ~28 pages
   * a full season needs. Hitting that ceiling stops pagination and returns whatever was fetched
   * so far instead of failing the whole call, since on those tiers this can only ever be a
   * partial result, not the complete season. */
  private async paginateLeaguePlayersForSeason<T>(
    season: number,
    toResult: (entry: RawPlayerStatisticsEntry) => T | null,
    scope: { league: number } | { team: number } = { league: PREMIER_LEAGUE_ID },
  ): Promise<T[]> {
    const results: T[] = [];
    let currentPage = 1;
    let totalPages = 1;

    do {
      let response: RawPlayerStatisticsEntry[];
      let paging: { current: number; total: number } | undefined;
      try {
        ({ response, paging } = await this.request<RawPlayerStatisticsEntry[]>("players", {
          ...scope,
          season,
          page: currentPage,
        }));
      } catch (error) {
        if (error instanceof Error && /page parameter/i.test(error.message)) {
          console.warn(
            `paginateLeaguePlayersForSeason: stopped at page ${currentPage} — plan's page limit reached (${error.message}). ` +
              `Returning ${results.length} entries fetched so far; this is a partial result on this plan tier.`,
          );
          break;
        }
        throw error;
      }

      totalPages = paging?.total ?? 1;

      for (const entry of response) {
        const mapped = toResult(entry);
        if (mapped !== null) results.push(mapped);
      }

      if (currentPage < totalPages) {
        await delay(INTER_REQUEST_DELAY_MS);
      }
      currentPage++;
    } while (currentPage <= totalPages);

    return results;
  }

  /** The complete league roster for the current season, including players fetchPlayerRoster's
   * squad snapshot misses (new signings, promoted-club players not yet linked to a squad
   * block). */
  async fetchAllPlayersForSeason(): Promise<ProviderRosterEntry[]> {
    return this.paginateLeaguePlayersForSeason(this.seasonYear, (entry) => {
      const statistics = entry.statistics[0];
      if (!statistics) return null;
      const position = mapProviderPositionLabel(statistics.games.position);
      if (!position) return null; // skip entries with no usable position (e.g. provider data gaps)
      return { externalId: String(entry.player.id), name: entry.player.name, club: statistics.team.name, position };
    });
  }

  /** Full-season aggregate stat lines (appearances, minutes, goals, assists, saves, cards) for
   * every player in the league for an arbitrary season — unlike fetchAllPlayersForSeason, `season`
   * is explicit rather than pinned to `this.seasonYear`, so one instance can pull a *previous*
   * season's stats (pre-season pricing hydration) without re-pinning state the current-season
   * import path relies on. */
  async fetchAllPlayerSeasonStatistics(season: number): Promise<PlayerSeasonStatistics[]> {
    return this.paginateLeaguePlayersForSeason(season, (entry) => toPlayerSeasonStatistics(entry, season));
  }

  async fetchInjuries(): Promise<ProviderInjuryEntry[]> {
    if (!this.coverageInjuries) return [];
    const { response } = await this.request<RawInjuryEntry[]>("injuries", {
      league: PREMIER_LEAGUE_ID,
      season: this.seasonYear,
    });
    return response.map((entry) => ({
      externalPlayerId: String(entry.player.id),
      type: entry.player.type,
      reason: entry.player.reason,
    }));
  }

  async fetchLeagueSeasons(): Promise<ProviderLeagueSeason[]> {
    const { response } = await this.request<RawLeagueEntry[]>("leagues", { id: PREMIER_LEAGUE_ID });
    const leagueEntry = response[0];
    if (!leagueEntry) return [];
    return leagueEntry.seasons.map((season) => ({
      seasonYear: season.year,
      isCurrentSeason: season.current,
      coverageFixturePlayerStats: season.coverage.fixtures.statistics_players,
      coveragePlayers: season.coverage.players,
      coverageInjuries: season.coverage.injuries,
    }));
  }

  async fetchLeagueCurrentSeason(): Promise<ProviderSeasonInfo | null> {
    return (await this.fetchLeagueSeasons()).find((season) => season.isCurrentSeason) ?? null;
  }

  async fetchQuotaStatus(): Promise<QuotaStatus> {
    const quotaFromHeaders = this.quotaStatusFromRateLimitSnapshotObservedToday();
    if (quotaFromHeaders) return quotaFromHeaders;
    const { response } = await this.request<RawStatusResponse>("status");
    return { requestsUsedToday: response.requests.current, requestsLimitPerDay: response.requests.limit_day };
  }

  async fetchPlayerProfile(externalPlayerId: string): Promise<PlayerProfile | null> {
    const { response } = await this.request<RawPlayerProfileEntry[]>("players/profiles", { player: externalPlayerId });
    const entry = response[0];
    if (!entry) return null;

    const { player } = entry;
    return {
      externalId: String(player.id),
      firstName: player.firstname ?? "",
      lastName: player.lastname ?? "",
      age: player.age,
      birthDate: player.birth.date,
      birthPlace: player.birth.place,
      birthCountry: player.birth.country,
      nationality: player.nationality,
      heightCm: parseLeadingNumber(player.height),
      weightKg: parseLeadingNumber(player.weight),
      shirtNumber: player.number,
      photoUrl: player.photo,
    };
  }

  async fetchPlayerSeasonStatistics(externalPlayerId: string, season: number): Promise<PlayerSeasonStatistics | null> {
    const { response } = await this.request<RawPlayerStatisticsEntry[]>("players", { id: externalPlayerId, season });
    const entry = response[0];
    return entry ? toPlayerSeasonStatistics(entry, season) : null;
  }

  async fetchPlayerSeasonStatisticsAcrossCompetitions(
    externalPlayerId: string,
    season: number,
  ): Promise<PlayerSeasonStatistics[]> {
    const { response } = await this.request<RawPlayerStatisticsEntry[]>("players", { id: externalPlayerId, season });
    const entry = response[0];
    return entry ? toAllPlayerSeasonStatistics(entry, season) : [];
  }

  async fetchTeamPlayerSeasonStatistics(externalTeamId: string, season: number): Promise<PlayerSeasonStatistics[]> {
    const perPlayerEntries = await this.paginateLeaguePlayersForSeason(
      season,
      (entry) => toAllPlayerSeasonStatistics(entry, season),
      { team: Number(externalTeamId) },
    );
    return perPlayerEntries.flat();
  }

  async fetchLeagueTeams(season: number): Promise<ProviderLeagueTeam[]> {
    const { response } = await this.request<RawTeam[]>("teams", { league: PREMIER_LEAGUE_ID, season });
    return response.map((entry) => ({ externalId: String(entry.team.id), name: entry.team.name }));
  }

  async fetchDomesticLeagueIds(): Promise<Set<number>> {
    // One unpaginated call returns every league the provider classifies as a domestic league
    // (type=league), which is what separates a Bundesliga season from a DFB Pokal run or a U21
    // international qualifying campaign in a player's competition list.
    const { response } = await this.request<RawLeagueTypeEntry[]>("leagues", { type: "league" });
    return new Set(response.map((entry) => entry.league.id).filter((id): id is number => id !== null));
  }
}
