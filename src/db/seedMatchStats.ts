import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  gameweeksRepository,
  leagueStandingsRepository,
  leaguesRepository,
  matchesRepository,
  matchGoalEventsRepository,
  playerMatchStatsRepository,
  playerScoresRepository,
  playersRepository,
  teamScoresRepository,
  teamsRepository,
  usersRepository,
} from "./repositories";
import type { Match, MatchGoalEvent, PlayerMatchStat, PlayerPosition } from "../domain";
import { STARTING_SQUAD_BUDGET_IN_MILLIONS } from "../domain";
import { calculatePlayerScores } from "../workers/calculatePlayerScores";
import { calculateTeamScores } from "../workers/calculateTeamScores";
import { updateStandings } from "../workers/updateStandings";

/**
 * Strategy 1 seed — injects a synthetic completed match with known player stats
 * and asserts that the full scoring cascade (calculatePlayerScores →
 * calculateTeamScores → updateStandings) produces the hand-computed expected
 * values below. Zero API calls. Re-runnable: all inserts are upserts or
 * find-or-creates keyed on the stable external IDs / emails / invite code below.
 *
 * Foundation for the vitest suite in Milestone 2 — port these assertions directly
 * into unit tests once vitest is wired up.
 */

// ─── Stable keys — never rename these or re-running will orphan old rows ────────

const GAMEWEEK_NUMBER = 99; // High enough to avoid colliding with seedMock (GW 1) or real data
const MATCH_EXTERNAL_ID = "stat-seed-match-1";
const LEAGUE_INVITE_CODE = "STATSEED1";
const USER_A_EMAIL = "stat-seed-user-a@seed.local";
const USER_B_EMAIL = "stat-seed-user-b@seed.local";

// ─── Scenario: Seed Arsenal 2-0 Seed Chelsea ────────────────────────────────────

const HOME_CLUB = "Seed Arsenal";
const AWAY_CLUB = "Seed Chelsea";
const FINAL_HOME_SCORE = 2;
const FINAL_AWAY_SCORE = 0;

interface SeedPlayer {
  externalId: string;
  name: string;
  club: string;
  position: PlayerPosition;
}

const SEED_PLAYERS: SeedPlayer[] = [
  { externalId: "stat-seed-gk-1",  name: "Seed Arsenal GK",  club: HOME_CLUB, position: "GK"  },
  { externalId: "stat-seed-def-1", name: "Seed Arsenal DEF", club: HOME_CLUB, position: "DEF" },
  { externalId: "stat-seed-mid-1", name: "Seed Arsenal MID", club: HOME_CLUB, position: "MID" },
  { externalId: "stat-seed-fwd-1", name: "Seed Arsenal FWD", club: HOME_CLUB, position: "FWD" },
  { externalId: "stat-seed-gk-2",  name: "Seed Chelsea GK",  club: AWAY_CLUB, position: "GK"  },
  { externalId: "stat-seed-fwd-2", name: "Seed Chelsea FWD", club: AWAY_CLUB, position: "FWD" },
];

// Goals in match: Arsenal DEF(1) + Arsenal MID(1) = 2 = FINAL_HOME_SCORE. ✓
interface SeedStat {
  externalPlayerId: string;
  minutesPlayed?: number;
  goalsScored?: number;
  assists?: number;
  savesCount?: number;
  ownGoalsScored?: number;
  penaltiesWon?: number;
  penaltiesConceded?: number;
  receivedYellowCard?: boolean;
  receivedRedCard?: boolean;
}

const SEED_STATS: SeedStat[] = [
  { externalPlayerId: "stat-seed-gk-1",  savesCount: 3 },
  { externalPlayerId: "stat-seed-def-1", goalsScored: 1 },
  { externalPlayerId: "stat-seed-mid-1", goalsScored: 1, assists: 1, receivedYellowCard: true },
  { externalPlayerId: "stat-seed-fwd-1", penaltiesWon: 1 },
  { externalPlayerId: "stat-seed-gk-2" },
  { externalPlayerId: "stat-seed-fwd-2", receivedRedCard: true },
];

interface SeedGoalEvent {
  externalScorerPlayerId: string;
  externalAssistPlayerId?: string;
  beneficiaryClub: string;
  elapsedMinute: number;
  addedTimeMinute?: number;
  sequenceIndex: number;
}

/**
 * The goal timeline behind the 2-0, chosen to exercise the game-state bonus: the 88th-minute
 * opener is the decisive goal (it put Arsenal ahead and the lead was never surrendered), so it
 * lands in the 86-90 bracket at a 2.0x multiplier — a bracket that catches both a broken
 * multiplier and a broken rounding path. The stoppage-time second goal is deliberately NOT
 * decisive, which is what proves "last go-ahead goal" is not just "last goal".
 */
const SEED_GOAL_EVENTS: SeedGoalEvent[] = [
  { externalScorerPlayerId: "stat-seed-def-1", externalAssistPlayerId: "stat-seed-mid-1", beneficiaryClub: HOME_CLUB, elapsedMinute: 88, sequenceIndex: 0 },
  { externalScorerPlayerId: "stat-seed-mid-1", beneficiaryClub: HOME_CLUB, elapsedMinute: 90, addedTimeMinute: 3, sequenceIndex: 1 },
];

// Hand-computed expected player scores — see point table in fantasy_league_v1_design.txt.
// The game-state bonus for the 88th-minute decisive goal is +/-10 (base 5 x the 2.0x bracket),
// paid to its scorer and assister and charged to the conceding club's starting GKs/DEFs.
//   GK-1:  1 appear + 4 cs + floor(3/3) saves = 6
//   DEF-1: 1 appear + 8 goal + 4 cs + 10 game-state (scored the winner) = 23
//   MID-1: 1 appear + 6 goal + 3 assist - 1 yellow + 10 game-state (assisted it) = 19
//   FWD-1: 1 appear + 2 pen_won = 3
//   GK-2:  1 appear (no cs — Arsenal scored 2) - 10 game-state (started, conceded it) = -9
//   FWD-2: 1 appear - 2 red = -1 (a FWD is out of the losing-goal penalty's scope)
const EXPECTED_PLAYER_POINTS: Record<string, number> = {
  "stat-seed-gk-1":  6,
  "stat-seed-def-1": 23,
  "stat-seed-mid-1": 19,
  "stat-seed-fwd-1": 3,
  "stat-seed-gk-2":  -9,
  "stat-seed-fwd-2": -1,
};

// Team A: Arsenal GK + DEF (captain, 23 pts) + MID (vc) + FWD.
//   Base: 6 + 23 + 19 + 3 = 51. Captain bonus: +23. Total: 74.
const EXPECTED_TEAM_A_POINTS = 74;

// Team B: Chelsea GK (captain, -9 pts) + FWD (vc).
//   Base: -9 + (-1) = -10. Captain bonus: -9. Total: -19.
const EXPECTED_TEAM_B_POINTS = -19;

// ─── Assertion helper ────────────────────────────────────────────────────────────

function assertPoints(label: string, expected: number, actual: number | null): void {
  const ok = actual === expected;
  const actualStr = actual === null ? " null" : String(actual).padStart(3);
  console.log(`  ${label.padEnd(20)}  expected ${String(expected).padStart(3)}  actual ${actualStr}  ${ok ? "✓" : "✗"}`);
  assert.strictEqual(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Seeding: Seed Arsenal 2-0 Seed Chelsea (GW 99)\n");

  // 1. Players
  for (const player of SEED_PLAYERS) {
    await playersRepository.upsertFromRosterImport(player);
  }
  const playerIdByExternalId = new Map<string, string>();
  for (const player of SEED_PLAYERS) {
    const row = await playersRepository.findByExternalId(player.externalId);
    if (row) playerIdByExternalId.set(player.externalId, row.id);
  }
  console.log(`  Upserted ${SEED_PLAYERS.length} players`);

  // 2. Gameweek
  const gameweek = await gameweeksRepository.upsertByNumber(
    GAMEWEEK_NUMBER,
    new Date(Date.now() - 24 * 60 * 60 * 1000),
  );
  console.log(`  Upserted gameweek ${GAMEWEEK_NUMBER}`);

  // 3. Match
  const existingMatch = await matchesRepository.findByExternalId(MATCH_EXTERNAL_ID);
  const match: Match = {
    id: existingMatch?.id ?? randomUUID(),
    externalId: MATCH_EXTERNAL_ID,
    gameweekId: gameweek.id,
    homeClub: HOME_CLUB,
    awayClub: AWAY_CLUB,
    kickoffAt: new Date(Date.now() - 20 * 60 * 60 * 1000),
    status: "COMPLETED",
    finalHomeScore: FINAL_HOME_SCORE,
    finalAwayScore: FINAL_AWAY_SCORE,
  };
  await matchesRepository.upsert(match);
  console.log(`  Upserted match ${MATCH_EXTERNAL_ID}`);

  // 4. Player match stats
  const stats: PlayerMatchStat[] = SEED_STATS.map((seed): PlayerMatchStat => {
    const playerId = playerIdByExternalId.get(seed.externalPlayerId);
    if (!playerId) throw new Error(`No player ID for externalId "${seed.externalPlayerId}"`);
    return {
      id: randomUUID(),
      matchId: match.id,
      playerId,
      minutesPlayed: seed.minutesPlayed ?? 90,
      goalsScored: seed.goalsScored ?? 0,
      assists: seed.assists ?? 0,
      savesCount: seed.savesCount ?? 0,
      ownGoalsScored: seed.ownGoalsScored ?? 0,
      penaltiesWon: seed.penaltiesWon ?? 0,
      penaltiesConceded: seed.penaltiesConceded ?? 0,
      receivedYellowCard: seed.receivedYellowCard ?? false,
      receivedRedCard: seed.receivedRedCard ?? false,
      // Seeded stat lines all represent players who featured from kickoff, which is what makes
      // the losing-goal penalty (starting GKs/DEFs only) reachable from seeded data.
      wasInStartingLineup: true,
    };
  });
  await playerMatchStatsRepository.replaceForMatch(match.id, stats);
  console.log(`  Replaced ${stats.length} PlayerMatchStat rows`);

  // 4b. Goal timeline — what the game-state bonus reads
  const goalEvents: MatchGoalEvent[] = SEED_GOAL_EVENTS.map((seed): MatchGoalEvent => {
    const scorerPlayerId = playerIdByExternalId.get(seed.externalScorerPlayerId);
    if (!scorerPlayerId) throw new Error(`No player ID for scorer "${seed.externalScorerPlayerId}"`);
    return {
      id: randomUUID(),
      matchId: match.id,
      scorerPlayerId,
      assistPlayerId: seed.externalAssistPlayerId ? (playerIdByExternalId.get(seed.externalAssistPlayerId) ?? null) : null,
      beneficiaryClub: seed.beneficiaryClub,
      goalType: "NORMAL",
      elapsedMinute: seed.elapsedMinute,
      addedTimeMinute: seed.addedTimeMinute ?? 0,
      sequenceIndex: seed.sequenceIndex,
    };
  });
  await matchGoalEventsRepository.replaceForMatch(match.id, goalEvents);
  console.log(`  Replaced ${goalEvents.length} MatchGoalEvent rows`);

  // 5. Users, league, teams
  let userA = await usersRepository.findByEmail(USER_A_EMAIL);
  if (!userA) userA = await usersRepository.insert({ id: randomUUID(), email: USER_A_EMAIL, displayName: "Seed User A", cognitoSub: null, handle: null, createdAt: new Date() });

  let userB = await usersRepository.findByEmail(USER_B_EMAIL);
  if (!userB) userB = await usersRepository.insert({ id: randomUUID(), email: USER_B_EMAIL, displayName: "Seed User B", cognitoSub: null, handle: null, createdAt: new Date() });

  let league = await leaguesRepository.findByInviteCode(LEAGUE_INVITE_CODE);
  if (!league) {
    league = await leaguesRepository.insert({
      id: randomUUID(),
      name: "Seed League",
      inviteCode: LEAGUE_INVITE_CODE,
      commissionerUserId: userA.id,
      areSettingsLocked: false,
      createdAt: new Date(),
    });
  }

  const pid = (externalId: string) => {
    const id = playerIdByExternalId.get(externalId);
    if (!id) throw new Error(`Missing player ID for "${externalId}"`);
    return id;
  };

  // Team A: Arsenal GK + DEF (captain) + MID (vc) + FWD — all starting
  let teamARow = await teamsRepository.findByLeagueAndUser(league.id, userA.id);
  if (!teamARow) {
    await teamsRepository.insert({ id: randomUUID(), leagueId: league.id, userId: userA.id, name: "Seed Team A", remainingBudgetInMillions: STARTING_SQUAD_BUDGET_IN_MILLIONS, bankedFreeTransferCount: 0 });
    teamARow = await teamsRepository.findByLeagueAndUser(league.id, userA.id);
  }
  const teamAId = teamARow!.id;
  await teamsRepository.replaceRosterSlots(teamAId, [
    { playerId: pid("stat-seed-gk-1"),  isStarting: true },
    { playerId: pid("stat-seed-def-1"), isStarting: true },
    { playerId: pid("stat-seed-mid-1"), isStarting: true },
    { playerId: pid("stat-seed-fwd-1"), isStarting: true },
  ], STARTING_SQUAD_BUDGET_IN_MILLIONS);
  await teamsRepository.updateLineup(teamAId, { formation: "4-4-2", captainPlayerId: pid("stat-seed-def-1"), viceCaptainPlayerId: pid("stat-seed-mid-1") });

  // Team B: Chelsea GK (captain) + FWD (vc) — both starting
  let teamBRow = await teamsRepository.findByLeagueAndUser(league.id, userB.id);
  if (!teamBRow) {
    await teamsRepository.insert({ id: randomUUID(), leagueId: league.id, userId: userB.id, name: "Seed Team B", remainingBudgetInMillions: STARTING_SQUAD_BUDGET_IN_MILLIONS, bankedFreeTransferCount: 0 });
    teamBRow = await teamsRepository.findByLeagueAndUser(league.id, userB.id);
  }
  const teamBId = teamBRow!.id;
  await teamsRepository.replaceRosterSlots(teamBId, [
    { playerId: pid("stat-seed-gk-2"),  isStarting: true },
    { playerId: pid("stat-seed-fwd-2"), isStarting: true },
  ], STARTING_SQUAD_BUDGET_IN_MILLIONS);
  await teamsRepository.updateLineup(teamBId, { formation: "4-4-2", captainPlayerId: pid("stat-seed-gk-2"), viceCaptainPlayerId: pid("stat-seed-fwd-2") });

  console.log(`  Seeded league "${league.name}" with 2 teams\n`);

  // 6. Scoring cascade
  console.log("Running scoring cascade...");
  await calculatePlayerScores(match.id);
  console.log("  calculatePlayerScores ✓");
  await calculateTeamScores(gameweek.id);
  console.log("  calculateTeamScores ✓");
  await updateStandings(league.id, gameweek.id);
  console.log("  updateStandings ✓\n");

  // 7. Assert player scores
  console.log("Asserting playerScores:");
  for (const seedPlayer of SEED_PLAYERS) {
    const playerId = playerIdByExternalId.get(seedPlayer.externalId)!;
    const score = await playerScoresRepository.findPlayerGameweekPoints(playerId, gameweek.id);
    assertPoints(seedPlayer.name, EXPECTED_PLAYER_POINTS[seedPlayer.externalId]!, score?.totalPoints ?? null);
  }

  // 8. Assert team scores
  console.log("\nAsserting teamScores:");
  const teamAScore = await teamScoresRepository.findByTeamAndGameweek(teamAId, gameweek.id);
  assertPoints("Seed Team A", EXPECTED_TEAM_A_POINTS, teamAScore?.totalPoints ?? null);
  const teamBScore = await teamScoresRepository.findByTeamAndGameweek(teamBId, gameweek.id);
  assertPoints("Seed Team B", EXPECTED_TEAM_B_POINTS, teamBScore?.totalPoints ?? null);

  // 9. Assert standings
  console.log("\nAsserting standings:");
  const standings = await leagueStandingsRepository.findForLeagueAndGameweek(league.id, gameweek.id);
  assert.strictEqual(standings.length, 2, `Expected 2 standings, got ${standings.length}`);
  assert.strictEqual(standings[0]!.teamId, teamAId, "rank 1 should be Team A");
  assert.strictEqual(standings[0]!.rank, 1);
  assert.strictEqual(standings[0]!.totalPoints, EXPECTED_TEAM_A_POINTS);
  console.log(`  rank 1  Seed Team A  ${standings[0]!.totalPoints} pts  ✓`);
  assert.strictEqual(standings[1]!.teamId, teamBId, "rank 2 should be Team B");
  assert.strictEqual(standings[1]!.rank, 2);
  assert.strictEqual(standings[1]!.totalPoints, EXPECTED_TEAM_B_POINTS);
  console.log(`  rank 2  Seed Team B   ${standings[1]!.totalPoints} pts  ✓`);

  console.log("\n✓ All assertions passed.");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
