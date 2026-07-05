import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  gameweeksRepository,
  leaguesRepository,
  matchesRepository,
  playerMatchStatsRepository,
  playersRepository,
} from "./repositories";
import type { Match, PlayerMatchStat, PlayerPosition } from "../domain";
import { calculatePlayerScores } from "../workers/calculatePlayerScores";
import { calculateTeamScores } from "../workers/calculateTeamScores";
import { updateStandings } from "../workers/updateStandings";

/**
 * Seeds a fixed, deterministic mock scenario (20 players, 1 gameweek, 2 completed matches with
 * stats) and runs the real scoring pipeline against it — so the leaderboard/squad-builder/player
 * pages have something to show without waiting on the live football API (which has no data yet
 * for the upcoming season; see docs/remaining-gaps-todo.md item 1). See
 * docs/manual-testing-guide.md for how this fits into a manual test session.
 *
 * Also reopens whichever gameweek is actually current (see the reopenedGameweek block below) —
 * without this, "current" resolves to whatever real 2024-25 season gameweek is still UPCOMING,
 * whose real kickoff dates are long past relative to any future system clock, locking every club.
 *
 * Safe to re-run: players/matches/gameweek are upserted by a fixed externalId/number, and stats/
 * scores/standings are replaced, not appended. Deliberately does NOT call
 * awardGameweekFreeTransfers or gameweeksRepository.markCompleted — those aren't idempotent
 * (they'd hand out another 2 free transfers per team on every re-run), and aren't needed just to
 * see computed scores on the leaderboard. Run a real gameweek-completion flow (or
 * runWorkerCycle against real data) if you specifically want to test that side of things.
 */

interface MockPlayer {
  externalId: string;
  name: string;
  club: string;
  position: PlayerPosition;
}

const MOCK_PLAYERS: MockPlayer[] = [
  { externalId: "mock-player-01", name: "Mock GK One", club: "Arsenal", position: "GK" },
  { externalId: "mock-player-02", name: "Mock GK Two", club: "Chelsea", position: "GK" },
  { externalId: "mock-player-03", name: "Mock GK Three", club: "Liverpool", position: "GK" },
  { externalId: "mock-player-04", name: "Mock DEF One", club: "Arsenal", position: "DEF" },
  { externalId: "mock-player-05", name: "Mock DEF Two", club: "Chelsea", position: "DEF" },
  { externalId: "mock-player-06", name: "Mock DEF Three", club: "Liverpool", position: "DEF" },
  { externalId: "mock-player-07", name: "Mock DEF Four", club: "Man City", position: "DEF" },
  { externalId: "mock-player-08", name: "Mock DEF Five", club: "Tottenham", position: "DEF" },
  { externalId: "mock-player-09", name: "Mock DEF Six", club: "Newcastle", position: "DEF" },
  { externalId: "mock-player-10", name: "Mock MID One", club: "Arsenal", position: "MID" },
  { externalId: "mock-player-11", name: "Mock MID Two", club: "Chelsea", position: "MID" },
  { externalId: "mock-player-12", name: "Mock MID Three", club: "Liverpool", position: "MID" },
  { externalId: "mock-player-13", name: "Mock MID Four", club: "Man City", position: "MID" },
  { externalId: "mock-player-14", name: "Mock MID Five", club: "Tottenham", position: "MID" },
  { externalId: "mock-player-15", name: "Mock MID Six", club: "Newcastle", position: "MID" },
  { externalId: "mock-player-16", name: "Mock FWD One", club: "Arsenal", position: "FWD" },
  { externalId: "mock-player-17", name: "Mock FWD Two", club: "Chelsea", position: "FWD" },
  { externalId: "mock-player-18", name: "Mock FWD Three", club: "Liverpool", position: "FWD" },
  { externalId: "mock-player-19", name: "Mock FWD Four", club: "Man City", position: "FWD" },
  { externalId: "mock-player-20", name: "Mock FWD Five", club: "Tottenham", position: "FWD" },
];

interface MockMatch {
  externalId: string;
  homeClub: string;
  awayClub: string;
  finalHomeScore: number;
  finalAwayScore: number;
  /** [externalPlayerId, statOverrides] — minutesPlayed defaults to 90 unless overridden. */
  stats: [string, Partial<Omit<ProviderStat, "externalPlayerId">>][];
}

interface ProviderStat {
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

const MOCK_MATCHES: MockMatch[] = [
  {
    externalId: "mock-match-1",
    homeClub: "Arsenal",
    awayClub: "Chelsea",
    finalHomeScore: 3,
    finalAwayScore: 1,
    stats: [
      ["mock-player-01", { savesCount: 4 }], // Arsenal GK
      ["mock-player-04", { goalsScored: 1 }], // Arsenal DEF
      ["mock-player-10", { goalsScored: 1, assists: 1, receivedYellowCard: true }], // Arsenal MID
      ["mock-player-16", { minutesPlayed: 85, goalsScored: 1, assists: 1, penaltiesWon: 1 }], // Arsenal FWD
      ["mock-player-02", { savesCount: 3, penaltiesConceded: 1 }], // Chelsea GK
      ["mock-player-17", { goalsScored: 1 }], // Chelsea FWD
    ],
  },
  {
    externalId: "mock-match-2",
    homeClub: "Liverpool",
    awayClub: "Man City",
    finalHomeScore: 1,
    finalAwayScore: 1,
    stats: [
      ["mock-player-03", { savesCount: 5 }], // Liverpool GK
      ["mock-player-12", { goalsScored: 1 }], // Liverpool MID
      ["mock-player-19", { goalsScored: 1, receivedRedCard: true }], // Man City FWD
      ["mock-player-07", { assists: 1 }], // Man City DEF
    ],
  },
];

function buildStat(externalPlayerId: string, overrides: Partial<Omit<ProviderStat, "externalPlayerId">>): ProviderStat {
  return {
    externalPlayerId,
    minutesPlayed: 90,
    goalsScored: 0,
    assists: 0,
    savesCount: 0,
    ownGoalsScored: 0,
    penaltiesWon: 0,
    penaltiesConceded: 0,
    receivedYellowCard: false,
    receivedRedCard: false,
    ...overrides,
  };
}

async function main(): Promise<void> {
  for (const player of MOCK_PLAYERS) {
    await playersRepository.upsertFromRosterImport(player);
  }
  const playerIdByExternalId = new Map<string, string>();
  for (const player of MOCK_PLAYERS) {
    const row = await playersRepository.findByExternalId(player.externalId);
    if (row) playerIdByExternalId.set(player.externalId, row.id);
  }

  // GW1: completed gameweek with historical match results (for testing scoring/leaderboard)
  const completedGameweek = await gameweeksRepository.upsertByNumber(1, new Date(Date.now() - 72 * 60 * 60 * 1000));

  const matchIds: string[] = [];
  for (const mockMatch of MOCK_MATCHES) {
    const existing = await matchesRepository.findByExternalId(mockMatch.externalId);
    const match: Match = {
      id: existing?.id ?? randomUUID(),
      externalId: mockMatch.externalId,
      gameweekId: completedGameweek.id,
      homeClub: mockMatch.homeClub,
      awayClub: mockMatch.awayClub,
      kickoffAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      status: "COMPLETED",
      finalHomeScore: mockMatch.finalHomeScore,
      finalAwayScore: mockMatch.finalAwayScore,
    };
    await matchesRepository.upsert(match);
    matchIds.push(match.id);

    const stats: PlayerMatchStat[] = mockMatch.stats
      .map(([externalPlayerId, overrides]) => buildStat(externalPlayerId, overrides))
      .map((stat): PlayerMatchStat | null => {
        const playerId = playerIdByExternalId.get(stat.externalPlayerId);
        if (!playerId) return null;
        return {
          id: randomUUID(),
          matchId: match.id,
          playerId,
          minutesPlayed: stat.minutesPlayed,
          goalsScored: stat.goalsScored,
          assists: stat.assists,
          savesCount: stat.savesCount,
          ownGoalsScored: stat.ownGoalsScored,
          penaltiesWon: stat.penaltiesWon,
          penaltiesConceded: stat.penaltiesConceded,
          receivedYellowCard: stat.receivedYellowCard,
          receivedRedCard: stat.receivedRedCard,
        };
      })
      .filter((stat): stat is PlayerMatchStat => stat !== null);

    await playerMatchStatsRepository.replaceForMatch(match.id, stats);
    await calculatePlayerScores(match.id);
  }

  await calculateTeamScores(completedGameweek.id);
  const leagues = await leaguesRepository.findAll();
  for (const league of leagues) {
    await updateStandings(league.id, completedGameweek.id);
  }

  // Whichever gameweek is *actually* current (findCurrent(): lowest-numbered one not yet
  // COMPLETED) is reopened with its real fixtures pushed into the future, so its clubs aren't
  // stuck locked by stale historical kickoff dates. A hardcoded gameweek number doesn't work here:
  // upsertByNumber never resets status on conflict, so targeting an already-COMPLETED gameweek
  // (real season data marks GW1-3 COMPLETED) would never actually become "current" regardless of
  // what deadline it's given.
  const currentGameweek = await gameweeksRepository.findCurrent();
  const reopenedGameweek: { id: string; number: number; newFirstKickoffAt: Date } | null = currentGameweek
    ? await (async () => {
        const gameweekMatches = await matchesRepository.findByGameweekId(currentGameweek.id);
        if (gameweekMatches.length === 0) return null;

        const earliestKickoffAt = gameweekMatches.reduce(
          (earliest, match) => (match.kickoffAt < earliest ? match.kickoffAt : earliest),
          gameweekMatches[0]!.kickoffAt,
        );
        const daysUntilFirstKickoff = 3;
        const targetFirstKickoffAt = new Date(Date.now() + daysUntilFirstKickoff * 24 * 60 * 60 * 1000);
        const offsetDays = Math.ceil(
          (targetFirstKickoffAt.getTime() - earliestKickoffAt.getTime()) / (24 * 60 * 60 * 1000),
        );
        const newFirstKickoffAt = new Date(earliestKickoffAt.getTime() + offsetDays * 24 * 60 * 60 * 1000);

        await matchesRepository.rescheduleGameweekIntoFuture(currentGameweek.id, offsetDays);
        await gameweeksRepository.reopenForTesting(currentGameweek.id, newFirstKickoffAt);
        return { id: currentGameweek.id, number: currentGameweek.number, newFirstKickoffAt };
      })()
    : null;

  console.log(
    JSON.stringify(
      {
        completedGameweek: {
          id: completedGameweek.id,
          number: completedGameweek.number,
          status: "COMPLETED (with scoring results)",
          matchIds,
        },
        reopenedGameweek: reopenedGameweek
          ? {
              id: reopenedGameweek.id,
              number: reopenedGameweek.number,
              status: "UPCOMING (real fixtures rescheduled into the future — no locked clubs)",
              newFirstKickoffAt: reopenedGameweek.newFirstKickoffAt,
            }
          : "no current gameweek found — nothing to reopen",
        players: MOCK_PLAYERS.map((player) => ({
          externalId: player.externalId,
          id: playerIdByExternalId.get(player.externalId),
          name: player.name,
          position: player.position,
        })),
        leaguesWithRecomputedStandings: leagues.map((league) => league.id),
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
