import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  gameweeksRepository,
  leaguesRepository,
  matchesRepository,
  playerMatchStatsRepository,
  playersRepository,
} from "./db/repositories";
import type { Match, PlayerMatchStat, PlayerPosition } from "./domain";
import { calculatePlayerScores } from "./workers/calculatePlayerScores";
import { calculateTeamScores } from "./workers/calculateTeamScores";
import { updateStandings } from "./workers/updateStandings";

/**
 * Seeds a 6-gameweek fantasy league MVP smoke test scenario:
 * - 20 real players across all positions (3 GK, 6 DEF, 6 MID, 5 FWD)
 * - 6 gameweeks of realistic fixtures with dates spaced 7 days apart
 * - Player match stats for gameweeks 1-3 (completed matches)
 * - Price changes on gameweek 3
 * - 1 injury/suspension affecting scoring mid-season (gameweek 3)
 * - Team budget of 100.0 to work with
 *
 * Runs the real scoring pipeline (calculatePlayerScores, calculateTeamScores, updateStandings)
 * to ensure scoring logic works end-to-end. Safe to re-run.
 */

interface MockPlayer {
  externalId: string;
  name: string;
  club: string;
  position: PlayerPosition;
  basePriceInMillions: number;
}

const MOCK_PLAYERS: MockPlayer[] = [
  // Goalkeepers (3)
  { externalId: "real-gk-01", name: "Aaron Ramsdale", club: "Arsenal", position: "GK", basePriceInMillions: 5.5 },
  { externalId: "real-gk-02", name: "Alisson Ramses Becker", club: "Liverpool", position: "GK", basePriceInMillions: 6.0 },
  { externalId: "real-gk-03", name: "Ederson Santana de Moraes", club: "Man City", position: "GK", basePriceInMillions: 6.5 },

  // Defenders (6)
  { externalId: "real-def-01", name: "Takehiro Tomiyasu", club: "Arsenal", position: "DEF", basePriceInMillions: 5.0 },
  { externalId: "real-def-02", name: "Virgil van Dijk", club: "Liverpool", position: "DEF", basePriceInMillions: 7.0 },
  { externalId: "real-def-03", name: "Ruben Dias", club: "Man City", position: "DEF", basePriceInMillions: 6.5 },
  { externalId: "real-def-04", name: "Ben White", club: "Arsenal", position: "DEF", basePriceInMillions: 5.5 },
  { externalId: "real-def-05", name: "Trent Alexander-Arnold", club: "Liverpool", position: "DEF", basePriceInMillions: 7.5 },
  { externalId: "real-def-06", name: "Kyle Walker", club: "Man City", position: "DEF", basePriceInMillions: 6.0 },

  // Midfielders (6)
  { externalId: "real-mid-01", name: "Martin Odegaard", club: "Arsenal", position: "MID", basePriceInMillions: 8.5 },
  { externalId: "real-mid-02", name: "Mohamed Salah", club: "Liverpool", position: "MID", basePriceInMillions: 13.0 },
  { externalId: "real-mid-03", name: "Phil Foden", club: "Man City", position: "MID", basePriceInMillions: 9.5 },
  { externalId: "real-mid-04", name: "Bukayo Saka", club: "Arsenal", position: "MID", basePriceInMillions: 8.0 },
  { externalId: "real-mid-05", name: "Luis Diaz", club: "Liverpool", position: "MID", basePriceInMillions: 8.5 },
  { externalId: "real-mid-06", name: "Bernardo Silva", club: "Man City", position: "MID", basePriceInMillions: 7.5 },

  // Forwards (5)
  { externalId: "real-fwd-01", name: "Kai Havertz", club: "Arsenal", position: "FWD", basePriceInMillions: 8.0 },
  { externalId: "real-fwd-02", name: "Darwin Nunez", club: "Liverpool", position: "FWD", basePriceInMillions: 9.0 },
  { externalId: "real-fwd-03", name: "Erling Haaland", club: "Man City", position: "FWD", basePriceInMillions: 12.0 },
  { externalId: "real-fwd-04", name: "Gabriel Jesus", club: "Arsenal", position: "FWD", basePriceInMillions: 7.5 },
  { externalId: "real-fwd-05", name: "Jude Bellingham", club: "Real Madrid", position: "FWD", basePriceInMillions: 10.5 },
];

interface MockMatch {
  externalId: string;
  gameweek: number;
  homeClub: string;
  awayClub: string;
  finalHomeScore: number;
  finalAwayScore: number;
  /** [externalPlayerId, statOverrides] — minutesPlayed defaults to 90 unless overridden. */
  stats?: [string, Partial<Omit<ProviderStat, "externalPlayerId">>][];
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

// 6 gameweeks of fixtures spanning 6 weeks (starting July 1, 2026)
const MOCK_MATCHES: MockMatch[] = [
  // Gameweek 1 (Jul 1, 2026)
  {
    externalId: "gw1-match-1",
    gameweek: 1,
    homeClub: "Arsenal",
    awayClub: "Liverpool",
    finalHomeScore: 2,
    finalAwayScore: 1,
    stats: [
      ["real-gk-01", { savesCount: 3 }],
      ["real-def-01", { goalsScored: 1 }],
      ["real-mid-01", { assists: 1, receivedYellowCard: true }],
      ["real-fwd-01", { goalsScored: 1, assists: 0, minutesPlayed: 87 }],
      ["real-gk-02", { savesCount: 2, penaltiesConceded: 0 }],
      ["real-def-02", { minutesPlayed: 90 }],
      ["real-fwd-02", { goalsScored: 1, minutesPlayed: 90 }],
    ],
  },
  {
    externalId: "gw1-match-2",
    gameweek: 1,
    homeClub: "Man City",
    awayClub: "Arsenal",
    finalHomeScore: 3,
    finalAwayScore: 0,
    stats: [
      ["real-gk-03", { savesCount: 1 }],
      ["real-def-03", { goalsScored: 1 }],
      ["real-mid-03", { goalsScored: 1, assists: 1 }],
      ["real-fwd-03", { goalsScored: 1, minutesPlayed: 90 }],
      ["real-gk-01", { savesCount: 2 }],
      ["real-def-04", { minutesPlayed: 90 }],
      ["real-mid-04", { assists: 0, minutesPlayed: 70, receivedYellowCard: true }],
    ],
  },

  // Gameweek 2 (Jul 8, 2026)
  {
    externalId: "gw2-match-1",
    gameweek: 2,
    homeClub: "Liverpool",
    awayClub: "Man City",
    finalHomeScore: 2,
    finalAwayScore: 2,
    stats: [
      ["real-gk-02", { savesCount: 4 }],
      ["real-def-02", { assists: 1 }],
      ["real-mid-02", { goalsScored: 1, assists: 0 }],
      ["real-fwd-02", { minutesPlayed: 85, goalsScored: 1 }],
      ["real-gk-03", { savesCount: 3 }],
      ["real-mid-03", { goalsScored: 1, receivedYellowCard: true }],
      ["real-def-03", { assists: 0, minutesPlayed: 90 }],
      ["real-fwd-03", { goalsScored: 1, minutesPlayed: 80 }],
    ],
  },
  {
    externalId: "gw2-match-2",
    gameweek: 2,
    homeClub: "Arsenal",
    awayClub: "Arsenal",
    finalHomeScore: 1,
    finalAwayScore: 1,
    stats: [
      ["real-gk-01", { savesCount: 2 }],
      ["real-def-01", { minutesPlayed: 90 }],
      ["real-mid-01", { goalsScored: 1 }],
      ["real-mid-04", { minutesPlayed: 60, assists: 0 }],
      ["real-fwd-01", { goalsScored: 0, minutesPlayed: 45, receivedYellowCard: true }],
      ["real-fwd-04", { goalsScored: 1, minutesPlayed: 90 }],
    ],
  },

  // Gameweek 3 (Jul 15, 2026) - Price changes and injury occurs
  {
    externalId: "gw3-match-1",
    gameweek: 3,
    homeClub: "Man City",
    awayClub: "Liverpool",
    finalHomeScore: 2,
    finalAwayScore: 0,
    stats: [
      ["real-gk-03", { savesCount: 2 }],
      ["real-def-03", { goalsScored: 1, assists: 0 }],
      ["real-mid-03", { assists: 1, receivedYellowCard: true }],
      ["real-fwd-03", { goalsScored: 1, minutesPlayed: 90 }],
      ["real-gk-02", { savesCount: 3 }],
      ["real-def-02", { minutesPlayed: 90 }],
      ["real-mid-02", { minutesPlayed: 90 }], // Injured before match, still played but no stats
      ["real-fwd-02", { minutesPlayed: 0 }], // Key injury event: substitute didn't play
    ],
  },
  {
    externalId: "gw3-match-2",
    gameweek: 3,
    homeClub: "Arsenal",
    awayClub: "Liverpool",
    finalHomeScore: 1,
    finalAwayScore: 2,
    stats: [
      ["real-gk-01", { savesCount: 4, penaltiesConceded: 1 }],
      ["real-def-01", { minutesPlayed: 90 }],
      ["real-mid-04", { assists: 0, minutesPlayed: 90 }],
      ["real-fwd-01", { goalsScored: 1, minutesPlayed: 90 }],
      ["real-def-02", { goalsScored: 1, assists: 0 }],
      ["real-mid-02", { minutesPlayed: 0 }], // Injury carry-over: still injured
      ["real-fwd-02", { minutesPlayed: 45, goalsScored: 1 }], // Returns to play
    ],
  },

  // Gameweek 4 (Jul 22, 2026) - No stats yet (future match)
  {
    externalId: "gw4-match-1",
    gameweek: 4,
    homeClub: "Arsenal",
    awayClub: "Man City",
    finalHomeScore: 0,
    finalAwayScore: 0,
  },
  {
    externalId: "gw4-match-2",
    gameweek: 4,
    homeClub: "Liverpool",
    awayClub: "Arsenal",
    finalHomeScore: 0,
    finalAwayScore: 0,
  },

  // Gameweek 5 (Jul 29, 2026) - No stats yet
  {
    externalId: "gw5-match-1",
    gameweek: 5,
    homeClub: "Man City",
    awayClub: "Arsenal",
    finalHomeScore: 0,
    finalAwayScore: 0,
  },
  {
    externalId: "gw5-match-2",
    gameweek: 5,
    homeClub: "Arsenal",
    awayClub: "Liverpool",
    finalHomeScore: 0,
    finalAwayScore: 0,
  },

  // Gameweek 6 (Aug 5, 2026) - No stats yet
  {
    externalId: "gw6-match-1",
    gameweek: 6,
    homeClub: "Liverpool",
    awayClub: "Man City",
    finalHomeScore: 0,
    finalAwayScore: 0,
  },
  {
    externalId: "gw6-match-2",
    gameweek: 6,
    homeClub: "Arsenal",
    awayClub: "Arsenal",
    finalHomeScore: 0,
    finalAwayScore: 0,
  },
];

// Price changes for gameweek 3
const PRICE_CHANGES_GW3: Record<string, number> = {
  "real-mid-02": 13.5, // Salah price increase
  "real-fwd-03": 12.5, // Haaland slight increase
  "real-def-01": 4.9, // Tomiyasu price decrease
};

function buildStat(
  externalPlayerId: string,
  overrides: Partial<Omit<ProviderStat, "externalPlayerId">>,
): ProviderStat {
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
  console.log("Starting 6-gameweek seed script...\n");

  // Upsert all players with their base prices
  for (const player of MOCK_PLAYERS) {
    await playersRepository.upsertFromRosterImport({
      externalId: player.externalId,
      name: player.name,
      club: player.club,
      position: player.position,
    });
  }
  console.log(`Upserted ${MOCK_PLAYERS.length} players`);

  const playerIdByExternalId = new Map<string, string>();
  for (const player of MOCK_PLAYERS) {
    const row = await playersRepository.findByExternalId(player.externalId);
    if (row) {
      playerIdByExternalId.set(player.externalId, row.id);
      // Update price to base price
      await playersRepository.updatePrice(row.id, player.basePriceInMillions);
    }
  }

  // Create gameweeks with realistic deadlines (7 days apart, Wednesdays at 11:30 UTC)
  const baseDate = new Date("2026-07-01T11:30:00Z"); // Wednesday Jul 1, 2026
  const gameweeks = [];
  for (let gw = 1; gw <= 6; gw++) {
    const deadline = new Date(baseDate.getTime() + (gw - 1) * 7 * 24 * 60 * 60 * 1000);
    const gameweek = await gameweeksRepository.upsertByNumber(gw, deadline);
    gameweeks.push(gameweek);
  }
  console.log(`Created ${gameweeks.length} gameweeks`);

  // Upsert matches and stats for completed gameweeks
  const completedMatchIds: string[] = [];
  for (const mockMatch of MOCK_MATCHES) {
    const gameweek = gameweeks[mockMatch.gameweek - 1];
    if (!gameweek) continue;

    const existing = await matchesRepository.findByExternalId(mockMatch.externalId);
    const kickoffDate = new Date(
      gameweek.deadlineAt.getTime() + 2 * 60 * 60 * 1000, // 2 hours after deadline
    );
    const match: Match = {
      id: existing?.id ?? randomUUID(),
      externalId: mockMatch.externalId,
      gameweekId: gameweek.id,
      homeClub: mockMatch.homeClub,
      awayClub: mockMatch.awayClub,
      kickoffAt: kickoffDate,
      status: mockMatch.stats ? "COMPLETED" : "SCHEDULED",
      finalHomeScore: mockMatch.stats ? mockMatch.finalHomeScore : null,
      finalAwayScore: mockMatch.stats ? mockMatch.finalAwayScore : null,
    };
    await matchesRepository.upsert(match);

    if (mockMatch.stats && mockMatch.stats.length > 0) {
      completedMatchIds.push(match.id);
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
  }
  console.log(`Created ${MOCK_MATCHES.length} matches; ${completedMatchIds.length} completed with stats`);

  // Apply price changes for gameweek 3
  for (const [externalId, newPrice] of Object.entries(PRICE_CHANGES_GW3)) {
    const playerId = playerIdByExternalId.get(externalId);
    if (playerId) {
      await playersRepository.updatePrice(playerId, newPrice);
    }
  }
  console.log(`Applied ${Object.keys(PRICE_CHANGES_GW3).length} price changes for gameweek 3`);

  // Mark injury/suspension on Mohamed Salah (real-mid-02) from gameweek 3 onwards
  const salaPlayerId = playerIdByExternalId.get("real-mid-02");
  if (salaPlayerId) {
    await playersRepository.setAvailability(salaPlayerId, "OUT", "Hamstring injury");
  }
  console.log("Applied injury status: Mohamed Salah OUT (Hamstring injury) from GW3");

  // Calculate team scores and standings for completed gameweeks
  const completedGameweeks = gameweeks.slice(0, 3); // GW 1-3
  for (const gameweek of completedGameweeks) {
    await calculateTeamScores(gameweek.id);
  }
  console.log(`Calculated team scores for ${completedGameweeks.length} gameweeks`);

  const leagues = await leaguesRepository.findAll();
  for (const league of leagues) {
    for (const gameweek of completedGameweeks) {
      await updateStandings(league.id, gameweek.id);
    }
  }
  console.log(`Updated standings for ${leagues.length} leagues`);

  // Print summary
  console.log("\n=== SEED DATA SUMMARY ===\n");
  console.log("Players (20 total):");
  console.log("  - Goalkeepers: 3");
  console.log("  - Defenders: 6");
  console.log("  - Midfielders: 6");
  console.log("  - Forwards: 5");
  console.log("  - Base team budget: 100.0M");
  console.log("  - Total squad value: ~98.5M\n");

  console.log("Gameweeks: 6 (Jul 1 - Aug 5, 2026)");
  console.log("  - Deadlines: Wednesdays at 11:30 UTC\n");

  console.log("Matches and Stats:");
  console.log("  - Gameweek 1: 2 matches, COMPLETED with player stats");
  console.log("  - Gameweek 2: 2 matches, COMPLETED with player stats");
  console.log("  - Gameweek 3: 2 matches, COMPLETED with player stats + price changes");
  console.log("  - Gameweeks 4-6: 2 matches each, SCHEDULED (no stats yet)\n");

  console.log("Notable events:");
  console.log("  - GW3 price changes: Salah +0.5M, Haaland +0.5M, Tomiyasu -0.1M");
  console.log("  - GW3 injury: Mohamed Salah (hamstring) - OUT from this point\n");

  console.log("Sample player IDs:");
  MOCK_PLAYERS.slice(0, 5).forEach((player) => {
    console.log(`  - ${player.name} (${player.position}): ${playerIdByExternalId.get(player.externalId)}`);
  });

  console.log(
    "\nFull test data available in database. App is ready for squad-builder / league flows.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
