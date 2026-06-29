import type { PlayerPosition } from "../domain";
import type {
  FootballDataProvider,
  ProviderFixture,
  ProviderInjuryEntry,
  ProviderPlayerMatchStat,
  ProviderRosterEntry,
  QuotaStatus,
} from "./footballDataProvider";

/** Premier League's API-Football league ID. */
const PREMIER_LEAGUE_ID = 39;

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

interface ApiFootballEnvelope<T> {
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
 * fixtures/players' single-letter games.position, and from /players' paginated season-stats shape. */
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
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly seasonYear: number,
  ) {}

  private async request<T>(path: string, params: Record<string, string | number> = {}): Promise<ApiFootballEnvelope<T>> {
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

  async fetchInjuries(): Promise<ProviderInjuryEntry[]> {
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

  async fetchQuotaStatus(): Promise<QuotaStatus> {
    const { response } = await this.request<RawStatusResponse>("status");
    return { requestsUsedToday: response.requests.current, requestsLimitPerDay: response.requests.limit_day };
  }
}

/** Builds the real provider from env vars (FOOTBALL_DATA_API_BASE_URL, FOOTBALL_DATA_API_KEY,
 * FOOTBALL_DATA_SEASON_YEAR) — the wiring used by both the Lambda handler and local dev worker. */
export function createFootballDataProviderFromEnv(): FootballDataProvider {
  const baseUrl = process.env.FOOTBALL_DATA_API_BASE_URL ?? "https://v3.football.api-sports.io";
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) throw new Error("FOOTBALL_DATA_API_KEY is not set");
  const seasonYear = Number(process.env.FOOTBALL_DATA_SEASON_YEAR ?? 2026);
  return new ApiFootballProvider(baseUrl, apiKey, seasonYear);
}
