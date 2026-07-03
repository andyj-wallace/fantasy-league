import { describe, expect, it } from "vitest";
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
