import type { PlayerPosition, PlayerProfile, PlayerSeasonStatistics } from "../domain";
import type {
  FootballDataProvider,
  ProviderFixture,
  ProviderInjuryEntry,
  ProviderPlayerMatchStat,
  ProviderRosterEntry,
  ProviderSeasonInfo,
  QuotaStatus,
} from "./footballDataProvider";

/** Premier League's API-Football league ID. */
const PREMIER_LEAGUE_ID = 39;

/** Inter-request delay for loops that issue several calls back to back (one /players/squads
 * call per club, one /players call per page) — lower API-Football plan tiers (including Free)
 * rate-limit per minute well below what a tight loop of ~20 calls produces with no delay at all,
 * so both loops below pace themselves against this. Configurable since the right value depends
 * on plan tier; default errs conservative since hitting it means a wasted, partially-completed
 * run. */
const INTER_REQUEST_DELAY_MS = Number(process.env.FOOTBALL_DATA_REQUEST_DELAY_MS ?? 7_000);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  player: { id: number | null; name: string | null };
}

interface RawFixturePlayerStatistics {
  games: { minutes: number | null };
  goals: { total: number | null; assists: number | null; saves: number | null };
  cards: { yellow: number | null; red: number | null };
  penalty: { won: number | null; commited?: number | null; committed?: number | null };
}

interface RawFixturePlayersBlock {
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

/** /players' paginated response shape: one entry per player, statistics[0] is their primary
 * club/position for the requested season (a player transferred mid-season has multiple entries —
 * we only need the first). */
interface RawPlayerSeasonEntry {
  player: { id: number; name: string };
  statistics: { team: { name: string }; games: { position: string | null } }[];
}

interface RawStatusResponse {
  requests: { current: number; limit_day: number };
}

interface RawLeagueSeasonEntry {
  year: number;
  current: boolean;
  coverage: {
    fixtures: { statistics_players: boolean };
    injuries: boolean;
  };
}

interface RawLeagueEntry {
  seasons: RawLeagueSeasonEntry[];
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

/** /players' single-player-and-season response — the same shape RawPlayerSeasonEntry uses for
 * the paginated league pull, but with the full statistics block this single-player lookup needs
 * (rating, goals, assists, saves, cards) rather than just team/position. */
interface RawPlayerWithStatisticsEntry {
  player: { id: number };
  statistics: {
    team: { name: string };
    league: { name: string };
    games: { appearences: number | null; minutes: number | null; position: string | null; rating: string | null };
    goals: { total: number | null; assists: number | null; saves: number | null };
    cards: { yellow: number | null; red: number | null };
  }[];
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
   * and recording providers can substitute recorded response envelopes for the network. */
  protected async request<T>(path: string, params: Record<string, string | number> = {}): Promise<ApiFootballEnvelope<T>> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, { headers: { "x-apisports-key": this.apiKey } });
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

  async fetchFixturePlayerStats(externalFixtureId: string): Promise<ProviderPlayerMatchStat[]> {
    if (!this.coverageFixturePlayerStats) {
      console.log(`[provider] fetchFixturePlayerStats skipped — statistics_players not covered for season ${this.seasonYear}`);
      return [];
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

    const stats: ProviderPlayerMatchStat[] = [];
    for (const teamBlock of playersResult.response) {
      for (const playerBlock of teamBlock.players) {
        const statistics = playerBlock.statistics[0];
        if (!statistics) continue;

        const externalPlayerId = String(playerBlock.player.id);
        stats.push({
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
        });
      }
    }
    return stats;
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

  /** Paginated /players?league&season&page pull — the complete league roster for a season,
   * including players fetchPlayerRoster's squad snapshot misses (new signings, promoted-club
   * players not yet linked to a squad block). Delays between pages (INTER_REQUEST_DELAY_MS) to
   * stay under the provider's per-minute rate limit; a full season is ~28 pages, so this is for
   * one-time hydration and monthly syncs, not a frequent check.
   *
   * Lower API-Football plan tiers (including Free) cap the `page` param itself — e.g. "Free
   * plans are limited to a maximum value of 3 for the Page parameter" — well below the ~28 pages
   * a full season needs. Hitting that ceiling stops pagination and returns whatever was fetched
   * so far instead of failing the whole call, since on those tiers this can only ever be a
   * partial supplement to fetchPlayerRoster's squad-based pull, not the complete roster. */
  async fetchAllPlayersForSeason(): Promise<ProviderRosterEntry[]> {
    const entries: ProviderRosterEntry[] = [];
    let currentPage = 1;
    let totalPages = 1;

    do {
      let response: RawPlayerSeasonEntry[];
      let paging: { current: number; total: number } | undefined;
      try {
        ({ response, paging } = await this.request<RawPlayerSeasonEntry[]>("players", {
          league: PREMIER_LEAGUE_ID,
          season: this.seasonYear,
          page: currentPage,
        }));
      } catch (error) {
        if (error instanceof Error && /page parameter/i.test(error.message)) {
          console.warn(
            `fetchAllPlayersForSeason: stopped at page ${currentPage} — plan's page limit reached (${error.message}). ` +
              `Returning ${entries.length} players fetched so far; this is a partial result on this plan tier.`,
          );
          break;
        }
        throw error;
      }

      totalPages = paging?.total ?? 1;

      for (const entry of response) {
        const statistics = entry.statistics[0];
        if (!statistics) continue;
        const position = mapProviderPositionLabel(statistics.games.position);
        if (!position) continue; // skip entries with no usable position (e.g. provider data gaps)
        entries.push({
          externalId: String(entry.player.id),
          name: entry.player.name,
          club: statistics.team.name,
          position,
        });
      }

      if (currentPage < totalPages) {
        await delay(INTER_REQUEST_DELAY_MS);
      }
      currentPage++;
    } while (currentPage <= totalPages);

    return entries;
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

  async fetchLeagueCurrentSeason(): Promise<ProviderSeasonInfo | null> {
    const { response } = await this.request<RawLeagueEntry[]>("leagues", { id: PREMIER_LEAGUE_ID });
    const leagueEntry = response[0];
    if (!leagueEntry) return null;
    const currentSeason = leagueEntry.seasons.find((s) => s.current);
    if (!currentSeason) return null;
    return {
      seasonYear: currentSeason.year,
      coverageFixturePlayerStats: currentSeason.coverage.fixtures.statistics_players,
      coverageInjuries: currentSeason.coverage.injuries,
    };
  }

  async fetchQuotaStatus(): Promise<QuotaStatus> {
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
    const { response } = await this.request<RawPlayerWithStatisticsEntry[]>("players", { id: externalPlayerId, season });
    const entry = response[0];
    const statistics = entry?.statistics[0];
    if (!entry || !statistics) return null;

    return {
      externalId: String(entry.player.id),
      season,
      club: statistics.team.name,
      leagueName: statistics.league.name,
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
}
