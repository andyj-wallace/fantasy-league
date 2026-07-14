import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFootballEnvelope } from "./apiFootballProvider";
import { ApiFootballProvider } from "./apiFootballProvider";

/**
 * Parsing tests for ApiFootballProvider.fetchFixturePlayerStats' players+events merge, fed with
 * in-memory envelopes mirroring API-Football's documented shapes (the recorded Tottenham 3-6
 * Liverpool fixture in __fixtures__ contains no own goal, so the own-goal attribution path is
 * pinned here with a synthetic event instead — same envelope shape, no extra API quota spent).
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

function playerStatisticsBlock(overrides: {
  minutes?: number | null;
  goals?: number | null;
  assists?: number | null;
  saves?: number | null;
  yellow?: number | null;
  red?: number | null;
  penaltyWon?: number | null;
  penaltyCommited?: number | null;
}) {
  return {
    games: { minutes: overrides.minutes ?? 90 },
    goals: { total: overrides.goals ?? null, assists: overrides.assists ?? null, saves: overrides.saves ?? null },
    cards: { yellow: overrides.yellow ?? 0, red: overrides.red ?? 0 },
    penalty: { won: overrides.penaltyWon ?? null, commited: overrides.penaltyCommited ?? null },
  };
}

describe("ApiFootballProvider.fetchFixturePlayerStats — players+events merge", () => {
  it("attributes own goals from the events feed to the right player and maps stat fields", async () => {
    const provider = new InMemoryEnvelopeProvider({
      "fixtures/players": [
        {
          players: [
            { player: { id: 100 }, statistics: [playerStatisticsBlock({ goals: 2, assists: 1, yellow: 1 })] },
            { player: { id: 200 }, statistics: [playerStatisticsBlock({ minutes: 78, red: 1 })] },
          ],
        },
        {
          players: [{ player: { id: 300 }, statistics: [playerStatisticsBlock({ saves: 5, penaltyCommited: 1 })] }],
        },
      ],
      "fixtures/events": [
        { type: "Goal", detail: "Normal Goal", player: { id: 100, name: "Scorer" } },
        { type: "Goal", detail: "Own Goal", player: { id: 200, name: "Unlucky Defender" } },
        { type: "Card", detail: "Yellow Card", player: { id: 100, name: "Scorer" } },
      ],
    });

    const stats = await provider.fetchFixturePlayerStats("12345");

    expect(stats).toHaveLength(3);
    const statByExternalPlayerId = new Map(stats.map((stat) => [stat.externalPlayerId, stat]));

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
        { players: [{ player: { id: 200 }, statistics: [playerStatisticsBlock({})] }] },
      ],
      "fixtures/events": [
        { type: "Goal", detail: "Own Goal", player: { id: 200, name: "Unlucky Defender" } },
        { type: "Goal", detail: "Own Goal", player: { id: 200, name: "Unlucky Defender" } },
        { type: "Goal", detail: "Own Goal", player: { id: null, name: null } },
      ],
    });

    const stats = await provider.fetchFixturePlayerStats("12345");

    expect(stats).toHaveLength(1);
    expect(stats[0]!.ownGoalsScored).toBe(2);
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
