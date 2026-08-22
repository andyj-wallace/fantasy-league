import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFootballEnvelope } from "./apiFootballProvider";
import { ApiFootballProvider } from "./apiFootballProvider";

/**
 * Parsing tests for ApiFootballProvider.fetchFixturePlayerStatsAndGoalEvents' players+events
 * merge, fed with in-memory envelopes mirroring API-Football's documented shapes (the recorded
 * Tottenham 3-6 Liverpool fixture in __fixtures__ contains no own goal, so the own-goal
 * attribution path is pinned here with a synthetic event instead — same envelope shape, no extra
 * API quota spent).
 */
class InMemoryEnvelopeProvider extends ApiFootballProvider {
  constructor(private readonly envelopesByPath: Record<string, unknown>) {
    super("https://in-memory.invalid", "test-no-key", 2024);
    this.setCurrentSeason(2024, { fixturePlayerStats: true, injuries: true });
  }

  protected override async request<T>(path: string): Promise<ApiFootballEnvelope<T>> {
    const response = this.envelopesByPath[path];
    if (response === undefined) throw new Error(`No in-memory envelope for path "${path}"`);
    return { response: response as T, errors: [] };
  }
}

const HOME_CLUB_NAME = "Home FC";
const AWAY_CLUB_NAME = "Away FC";

function playerStatisticsBlock(overrides: {
  minutes?: number | null;
  substitute?: boolean | null;
  goals?: number | null;
  assists?: number | null;
  saves?: number | null;
  yellow?: number | null;
  red?: number | null;
  penaltyWon?: number | null;
  penaltyCommited?: number | null;
}) {
  return {
    games: { minutes: overrides.minutes ?? 90, substitute: overrides.substitute === undefined ? false : overrides.substitute },
    goals: { total: overrides.goals ?? null, assists: overrides.assists ?? null, saves: overrides.saves ?? null },
    cards: { yellow: overrides.yellow ?? 0, red: overrides.red ?? 0 },
    penalty: { won: overrides.penaltyWon ?? null, commited: overrides.penaltyCommited ?? null },
  };
}

/** One entry of /fixtures/events. `club` is the provider's own attribution — for an own goal that
 * is the scorer's club, not the club the goal counts for. */
function fixtureEvent(overrides: {
  type?: string;
  detail?: string;
  club: string;
  elapsed?: number | null;
  extra?: number | null;
  playerId?: number | null;
  assistId?: number | null;
}) {
  return {
    type: overrides.type ?? "Goal",
    detail: overrides.detail ?? "Normal Goal",
    time: { elapsed: overrides.elapsed ?? 30, extra: overrides.extra ?? null },
    team: { name: overrides.club },
    player: { id: overrides.playerId ?? null, name: null },
    assist: { id: overrides.assistId ?? null, name: null },
  };
}

describe("ApiFootballProvider.fetchFixturePlayerStatsAndGoalEvents — players+events merge", () => {
  it("attributes own goals from the events feed to the right player and maps stat fields", async () => {
    const provider = new InMemoryEnvelopeProvider({
      "fixtures/players": [
        {
          team: { name: HOME_CLUB_NAME },
          players: [
            { player: { id: 100 }, statistics: [playerStatisticsBlock({ goals: 2, assists: 1, yellow: 1 })] },
            { player: { id: 200 }, statistics: [playerStatisticsBlock({ minutes: 78, red: 1 })] },
          ],
        },
        {
          team: { name: AWAY_CLUB_NAME },
          players: [{ player: { id: 300 }, statistics: [playerStatisticsBlock({ saves: 5, penaltyCommited: 1 })] }],
        },
      ],
      "fixtures/events": [
        fixtureEvent({ detail: "Normal Goal", club: HOME_CLUB_NAME, playerId: 100 }),
        fixtureEvent({ detail: "Own Goal", club: HOME_CLUB_NAME, playerId: 200 }),
        fixtureEvent({ type: "Card", detail: "Yellow Card", club: HOME_CLUB_NAME, playerId: 100 }),
      ],
    });

    const { playerStats } = await provider.fetchFixturePlayerStatsAndGoalEvents("12345");

    expect(playerStats).toHaveLength(3);
    const statByExternalPlayerId = new Map(playerStats.map((stat) => [stat.externalPlayerId, stat]));

    const scorer = statByExternalPlayerId.get("100")!;
    expect(scorer.goalsScored).toBe(2);
    expect(scorer.assists).toBe(1);
    expect(scorer.ownGoalsScored).toBe(0);
    expect(scorer.receivedYellowCard).toBe(true);
    expect(scorer.receivedRedCard).toBe(false);

    const ownGoalScorer = statByExternalPlayerId.get("200")!;
    expect(ownGoalScorer.ownGoalsScored).toBe(1);
    expect(ownGoalScorer.goalsScored).toBe(0);
    expect(ownGoalScorer.minutesPlayed).toBe(78);
    expect(ownGoalScorer.receivedRedCard).toBe(true);

    const goalkeeper = statByExternalPlayerId.get("300")!;
    expect(goalkeeper.savesCount).toBe(5);
    expect(goalkeeper.penaltiesConceded).toBe(1);
  });

  it("counts multiple own goals by the same player and skips events with no player id", async () => {
    const provider = new InMemoryEnvelopeProvider({
      "fixtures/players": [
        { team: { name: HOME_CLUB_NAME }, players: [{ player: { id: 200 }, statistics: [playerStatisticsBlock({})] }] },
      ],
      "fixtures/events": [
        fixtureEvent({ detail: "Own Goal", club: HOME_CLUB_NAME, playerId: 200 }),
        fixtureEvent({ detail: "Own Goal", club: HOME_CLUB_NAME, playerId: 200 }),
        fixtureEvent({ detail: "Own Goal", club: HOME_CLUB_NAME, playerId: null }),
      ],
    });

    const { playerStats } = await provider.fetchFixturePlayerStatsAndGoalEvents("12345");

    expect(playerStats).toHaveLength(1);
    expect(playerStats[0]!.ownGoalsScored).toBe(2);
  });

  it("treats only an explicit substitute:false as having started, never a null or absent flag", async () => {
    const provider = new InMemoryEnvelopeProvider({
      "fixtures/players": [
        {
          team: { name: HOME_CLUB_NAME },
          players: [
            { player: { id: 100 }, statistics: [playerStatisticsBlock({ substitute: false })] },
            { player: { id: 200 }, statistics: [playerStatisticsBlock({ substitute: true })] },
            { player: { id: 300 }, statistics: [playerStatisticsBlock({ substitute: null })] },
          ],
        },
      ],
      "fixtures/events": [],
    });

    const { playerStats } = await provider.fetchFixturePlayerStatsAndGoalEvents("12345");

    expect(playerStats.map((stat) => stat.wasInStartingLineup)).toEqual([true, false, false]);
  });
});

describe("ApiFootballProvider.fetchFixturePlayerStatsAndGoalEvents — goal timeline", () => {
  function twoClubFixtureProvider(events: unknown[]): InMemoryEnvelopeProvider {
    return new InMemoryEnvelopeProvider({
      "fixtures/players": [
        { team: { name: HOME_CLUB_NAME }, players: [{ player: { id: 100 }, statistics: [playerStatisticsBlock({})] }] },
        { team: { name: AWAY_CLUB_NAME }, players: [{ player: { id: 200 }, statistics: [playerStatisticsBlock({})] }] },
      ],
      "fixtures/events": events,
    });
  }

  it("credits an own goal to the opposing club, not the club the provider attributes it to", async () => {
    const provider = twoClubFixtureProvider([
      fixtureEvent({ detail: "Own Goal", club: HOME_CLUB_NAME, playerId: 100, assistId: 999, elapsed: 62 }),
    ]);

    const { goalEvents } = await provider.fetchFixturePlayerStatsAndGoalEvents("12345");

    expect(goalEvents).toEqual([
      {
        externalScorerPlayerId: "100",
        // An own goal has no assister to credit, whatever the provider reports alongside it.
        externalAssistPlayerId: null,
        beneficiaryClub: AWAY_CLUB_NAME,
        goalType: "OWN_GOAL",
        elapsedMinute: 62,
        addedTimeMinute: 0,
        sequenceIndex: 0,
      },
    ]);
  });

  it("credits a normal goal to the scoring club and carries its assist through", async () => {
    const provider = twoClubFixtureProvider([
      fixtureEvent({ detail: "Normal Goal", club: AWAY_CLUB_NAME, playerId: 200, assistId: 201, elapsed: 90, extra: 4 }),
    ]);

    const { goalEvents } = await provider.fetchFixturePlayerStatsAndGoalEvents("12345");

    expect(goalEvents).toEqual([
      {
        externalScorerPlayerId: "200",
        externalAssistPlayerId: "201",
        beneficiaryClub: AWAY_CLUB_NAME,
        goalType: "NORMAL",
        elapsedMinute: 90,
        addedTimeMinute: 4,
        sequenceIndex: 0,
      },
    ]);
  });

  it("keeps penalties, drops missed penalties and non-goal events, and indexes by raw feed position", async () => {
    const provider = twoClubFixtureProvider([
      fixtureEvent({ type: "Card", detail: "Yellow Card", club: HOME_CLUB_NAME, playerId: 100 }),
      // Reported as type "Goal" by the provider, but no goal was scored — including it would move
      // the running scoreline and mis-identify the decisive goal.
      fixtureEvent({ detail: "Missed Penalty", club: HOME_CLUB_NAME, playerId: 100, elapsed: 55 }),
      fixtureEvent({ detail: "Penalty", club: AWAY_CLUB_NAME, playerId: 200, elapsed: 70 }),
      fixtureEvent({ type: "subst", detail: "Substitution 1", club: AWAY_CLUB_NAME, playerId: 200 }),
    ]);

    const { goalEvents } = await provider.fetchFixturePlayerStatsAndGoalEvents("12345");

    expect(goalEvents).toHaveLength(1);
    expect(goalEvents[0]!.goalType).toBe("PENALTY");
    expect(goalEvents[0]!.elapsedMinute).toBe(70);
    expect(goalEvents[0]!.sequenceIndex).toBe(2);
  });
});

/** Builds one /players response entry — the shape shared by fetchAllPlayersForSeason,
 * fetchAllPlayerSeasonStatistics, and fetchPlayerSeasonStatistics. */
function playerSeasonEntry(overrides: {
  id?: number;
  name?: string;
  team?: string;
  league?: string;
  position?: string | null;
  appearances?: number | null;
  minutes?: number | null;
  rating?: string | null;
  goals?: number | null;
  assists?: number | null;
  saves?: number | null;
  yellow?: number | null;
  red?: number | null;
}) {
  return {
    player: { id: overrides.id ?? 1, name: overrides.name ?? "Test Player" },
    statistics: [
      {
        team: { name: overrides.team ?? "Test FC" },
        league: { name: overrides.league ?? "Premier League" },
        games: {
          appearences: overrides.appearances ?? 20,
          minutes: overrides.minutes ?? 1800,
          position: overrides.position === undefined ? "Midfielder" : overrides.position,
          rating: overrides.rating ?? null,
        },
        goals: { total: overrides.goals ?? 0, assists: overrides.assists ?? 0, saves: overrides.saves ?? 0 },
        cards: { yellow: overrides.yellow ?? 0, red: overrides.red ?? 0 },
      },
    ],
  };
}

/** Replays a fixed sequence of /players pages by `page` param, optionally throwing the free-tier
 * "page parameter" error text on a given page — for exercising paginateLeaguePlayersForSeason
 * (shared by fetchAllPlayersForSeason and fetchAllPlayerSeasonStatistics) without real network or
 * real inter-page delays. */
class PaginatedPlayersProvider extends ApiFootballProvider {
  constructor(
    private readonly pageResponses: unknown[][],
    private readonly throwPageParameterErrorOnPage?: number,
  ) {
    super("https://in-memory.invalid", "test-no-key", 2024);
  }

  protected override async request<T>(_path: string, params: Record<string, string | number> = {}): Promise<ApiFootballEnvelope<T>> {
    const page = Number(params.page ?? 1);
    if (this.throwPageParameterErrorOnPage === page) {
      throw new Error("Free plans are limited to a maximum value of 3 for the Page parameter.");
    }
    const response = this.pageResponses[page - 1] ?? [];
    return { response: response as T, errors: [], paging: { current: page, total: this.pageResponses.length } };
  }
}

describe("ApiFootballProvider.fetchAllPlayerSeasonStatistics", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps a single-page response's full stat fields", async () => {
    const provider = new PaginatedPlayersProvider([
      [
        playerSeasonEntry({
          id: 100,
          name: "Erling Haaland",
          team: "Man City",
          league: "Premier League",
          position: "Attacker",
          appearances: 31,
          minutes: 2790,
          rating: "7.85",
          goals: 27,
          assists: 5,
          saves: null,
          yellow: 2,
          red: 0,
        }),
      ],
    ]);

    const stats = await provider.fetchAllPlayerSeasonStatistics(2024);

    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual({
      externalId: "100",
      season: 2024,
      club: "Man City",
      leagueName: "Premier League",
      position: "FWD",
      appearances: 31,
      minutesPlayed: 2790,
      rating: 7.85,
      goals: 27,
      assists: 5,
      saves: 0,
      yellowCards: 2,
      redCards: 0,
    });
  });

  it("concatenates entries across multiple pages", async () => {
    const provider = new PaginatedPlayersProvider([
      [playerSeasonEntry({ id: 1, name: "Player One" })],
      [playerSeasonEntry({ id: 2, name: "Player Two" })],
    ]);

    vi.useFakeTimers();
    const resultPromise = provider.fetchAllPlayerSeasonStatistics(2024);
    await vi.advanceTimersByTimeAsync(10_000); // covers the inter-page delay between page 1 and 2
    const stats = await resultPromise;

    expect(stats.map((s) => s.externalId)).toEqual(["1", "2"]);
  });

  it("stops at the free tier's page cap and returns the partial result instead of throwing", async () => {
    const provider = new PaginatedPlayersProvider(
      [[playerSeasonEntry({ id: 1 })], [playerSeasonEntry({ id: 2 })], [playerSeasonEntry({ id: 3 })]],
      2, // throws on page 2
    );

    vi.useFakeTimers();
    const resultPromise = provider.fetchAllPlayerSeasonStatistics(2024);
    await vi.advanceTimersByTimeAsync(10_000);
    const stats = await resultPromise;

    expect(stats.map((s) => s.externalId)).toEqual(["1"]);
  });
});

describe("ApiFootballProvider.fetchAllPlayersForSeason", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps identity fields and skips entries with no usable position", async () => {
    const provider = new PaginatedPlayersProvider([
      [
        playerSeasonEntry({ id: 1, name: "Bukayo Saka", team: "Arsenal", position: "Midfielder" }),
        playerSeasonEntry({ id: 2, name: "No Position", position: null }),
      ],
    ]);

    const roster = await provider.fetchAllPlayersForSeason();

    expect(roster).toEqual([{ externalId: "1", name: "Bukayo Saka", club: "Arsenal", position: "MID" }]);
  });
});

describe("ApiFootballProvider.fetchPlayerSeasonStatistics", () => {
  it("looks up a single player by id and season, unscoped by league", async () => {
    const provider = new PaginatedPlayersProvider([
      [playerSeasonEntry({ id: 55, team: "Leeds United", league: "Championship", appearances: 40, minutes: 3500 })],
    ]);

    const stats = await provider.fetchPlayerSeasonStatistics("55", 2023);

    expect(stats).not.toBeNull();
    expect(stats!.club).toBe("Leeds United");
    expect(stats!.leagueName).toBe("Championship");
    expect(stats!.appearances).toBe(40);
  });

  it("returns null when the player has no statistics entry for the season", async () => {
    const provider = new PaginatedPlayersProvider([[]]);
    const stats = await provider.fetchPlayerSeasonStatistics("999", 2023);
    expect(stats).toBeNull();
  });
});

/** One entry of the `fixtures?ids=` response, in the shape verified against the live API on
 * 2026-08-22 — identical to the season fixture list's, which is why a reconciled fixture needs no
 * import path of its own. */
function rawFixtureEntry(overrides: {
  id: number;
  round?: string;
  date?: string;
  statusShort?: string;
  statusLong?: string;
  elapsed?: number | null;
  home?: string;
  away?: string;
  homeGoals?: number | null;
  awayGoals?: number | null;
}) {
  return {
    fixture: {
      id: overrides.id,
      date: overrides.date ?? "2026-08-21T19:00:00+00:00",
      status: {
        short: overrides.statusShort ?? "FT",
        long: overrides.statusLong ?? "Match Finished",
        elapsed: overrides.elapsed === undefined ? 90 : overrides.elapsed,
      },
    },
    league: { round: overrides.round ?? "Regular Season - 1" },
    teams: { home: { name: overrides.home ?? HOME_CLUB_NAME }, away: { name: overrides.away ?? AWAY_CLUB_NAME } },
    goals: { home: overrides.homeGoals ?? null, away: overrides.awayGoals ?? null },
  };
}

/** Replays `fixtures?ids=` envelopes keyed by the fixture ids each batch asks for, and records
 * every request — so both halves of the contract (what goes out, what comes back) are pinned
 * without spending a real call. */
class InMemoryFixturesByIdsProvider extends ApiFootballProvider {
  readonly requestedFixtureIdParameters: string[] = [];

  constructor(private readonly rawFixtureEntriesByExternalId: Record<string, unknown> = {}) {
    super("https://in-memory.invalid", "test-no-key", 2026);
  }

  protected override async request<T>(path: string, params: Record<string, string | number> = {}): Promise<ApiFootballEnvelope<T>> {
    if (path !== "fixtures" || params.ids === undefined) throw new Error(`Unexpected request: ${path} ${JSON.stringify(params)}`);
    const requestedIds = String(params.ids);
    this.requestedFixtureIdParameters.push(requestedIds);
    const matchedEntries = requestedIds
      .split("-")
      .flatMap((externalId) => this.rawFixtureEntriesByExternalId[externalId] ?? []);
    return { response: matchedEntries as T, errors: [] };
  }
}

describe("ApiFootballProvider.fetchFixturesByExternalIds", () => {
  it("asks for every id in one dash-joined request", async () => {
    const provider = new InMemoryFixturesByIdsProvider();

    await provider.fetchFixturesByExternalIds(["1557367", "1557368", "1557369"]);

    expect(provider.requestedFixtureIdParameters).toEqual(["1557367-1557368-1557369"]);
  });

  it("splits ids into batches of 20, the provider's per-request cap", async () => {
    const provider = new InMemoryFixturesByIdsProvider();
    const twentyOneExternalIds = Array.from({ length: 21 }, (_, index) => String(1000 + index));

    await provider.fetchFixturesByExternalIds(twentyOneExternalIds);

    expect(provider.requestedFixtureIdParameters).toHaveLength(2);
    expect(provider.requestedFixtureIdParameters[0]!.split("-")).toHaveLength(20);
    expect(provider.requestedFixtureIdParameters[1]).toBe("1020");
  });

  it("spends no request at all on an empty id list", async () => {
    const provider = new InMemoryFixturesByIdsProvider();

    const fixtures = await provider.fetchFixturesByExternalIds([]);

    expect(fixtures).toEqual([]);
    expect(provider.requestedFixtureIdParameters).toEqual([]);
  });

  it("de-duplicates ids before batching so a repeated id never costs a second slot", async () => {
    const provider = new InMemoryFixturesByIdsProvider();

    await provider.fetchFixturesByExternalIds(["1557367", "1557368", "1557367"]);

    expect(provider.requestedFixtureIdParameters).toEqual(["1557367-1557368"]);
  });

  it("maps round label, kickoff, status code and scores off the standard fixtures envelope", async () => {
    const provider = new InMemoryFixturesByIdsProvider({
      "1557367": rawFixtureEntry({
        id: 1557367,
        round: "Regular Season - 1",
        date: "2026-08-21T19:00:00+00:00",
        statusShort: "FT",
        home: "Arsenal",
        away: "Coventry",
        homeGoals: 3,
        awayGoals: 0,
      }),
      "1557368": rawFixtureEntry({
        id: 1557368,
        statusShort: "NS",
        statusLong: "Not Started",
        elapsed: null,
        home: "Hull City",
        away: "Man United",
      }),
    });

    const fixtures = await provider.fetchFixturesByExternalIds(["1557367", "1557368"]);

    expect(fixtures).toEqual([
      {
        externalId: "1557367",
        roundLabel: "Regular Season - 1",
        homeClub: "Arsenal",
        awayClub: "Coventry",
        kickoffAt: new Date("2026-08-21T19:00:00Z"),
        statusShortCode: "FT",
        finalHomeScore: 3,
        finalAwayScore: 0,
      },
      {
        externalId: "1557368",
        roundLabel: "Regular Season - 1",
        homeClub: "Hull City",
        awayClub: "Man United",
        kickoffAt: new Date("2026-08-21T19:00:00Z"),
        statusShortCode: "NS",
        finalHomeScore: null,
        finalAwayScore: null,
      },
    ]);
  });

  it("propagates a failed request rather than swallowing it — degrading is the caller's decision", async () => {
    class FailingFixturesProvider extends ApiFootballProvider {
      protected override async request<T>(): Promise<ApiFootballEnvelope<T>> {
        throw new Error("API-Football request failed: 500 Internal Server Error (fixtures)");
      }
    }
    const provider = new FailingFixturesProvider("https://in-memory.invalid", "test-no-key", 2026);

    await expect(provider.fetchFixturesByExternalIds(["1557367"])).rejects.toThrow("API-Football request failed");
  });
});
