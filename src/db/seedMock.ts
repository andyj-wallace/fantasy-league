import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, isLocalDatabaseUrl } from "./client";
import {
  gameweeks as gameweeksTable,
  leagueStandings as leagueStandingsTable,
  matchGoalEvents as matchGoalEventsTable,
  matches as matchesTable,
  playerMatchStats as playerMatchStatsTable,
  playerScores as playerScoresTable,
  players as playersTable,
  teamScores as teamScoresTable,
  transfers as transfersTable,
} from "./schema";
import {
  gameweeksRepository,
  leaguesRepository,
  matchGoalEventsRepository,
  matchesRepository,
  playerMatchStatsRepository,
  playersRepository,
  teamsRepository,
} from "./repositories";
import {
  MAX_PLAYERS_PER_CLUB,
  REQUIRED_GOALKEEPER_COUNT,
  SQUAD_SIZE,
  STARTING_SQUAD_BUDGET_IN_MILLIONS,
  validateSquadComposition,
  type Match,
  type MatchGoalEvent,
  type Player,
  type PlayerMatchStat,
  type PlayerPosition,
  type StartingFormation,
  type TeamRosterSlot,
} from "../domain";
import { importPlayerAvailability } from "../workers/importPlayerAvailability";
import { OfflineFootballDataProvider } from "../workers/offlineFootballDataProvider";
import { calculatePlayerScores } from "../workers/calculatePlayerScores";
import { calculateTeamScores } from "../workers/calculateTeamScores";
import { updateStandings } from "../workers/updateStandings";

/**
 * Brings a local database as close to production's shape as it can get without spending provider
 * quota, so the app can be exercised by hand against realistic data. Replaces the original
 * 20-synthetic-player seed: real squads are already imported locally by `npm run hydrate:roster`,
 * and inventing "Mock GK One" alongside them only made discovery, pricing and locking harder to
 * read. See docs/manual-testing-guide.md.
 *
 * Two modes:
 *
 * - Default (`npm run seed:mock`) — non-destructive. Hides players outside the current Premier
 *   League squads from discovery, syncs real injury data from the recorded provider fixture, and
 *   pushes the current gameweek's fixtures far enough into the future that no club is locked.
 *
 * - `npm run seed:mock -- --reset` — additionally *deletes* every match, gameweek, transfer and
 *   computed score, then rebuilds a clean five-gameweek season over the current 20 clubs, refills
 *   every local team's roster with real players, and re-runs the scoring pipeline. This is the
 *   mode that produces a genuinely prod-like database; the default mode can only tidy what's
 *   already there.
 *
 * Both modes refuse to run against a non-local DATABASE_URL. Neither awards free transfers nor
 * marks a gameweek complete — those aren't idempotent (every run would hand out another 2 free
 * transfers per team) and aren't needed to see computed scores on the leaderboard.
 */

/**
 * The clubs a current-season roster import would find, spelled exactly as the provider spells them
 * in `players.club` — the lock check matches fixture club against player club as plain strings, so
 * a near-miss ("Man City" vs "Manchester City") silently means a club that can never lock.
 * Everything outside this list — relegated clubs still in the table from an earlier import, and
 * legacy seed rows — is what stage 1 hides.
 */
const CURRENT_SEASON_PREMIER_LEAGUE_CLUBS = [
  "Arsenal",
  "Aston Villa",
  "Bournemouth",
  "Brentford",
  "Brighton",
  "Burnley",
  "Chelsea",
  "Crystal Palace",
  "Everton",
  "Fulham",
  "Leeds",
  "Liverpool",
  "Manchester City",
  "Manchester United",
  "Newcastle",
  "Nottingham Forest",
  "Sunderland",
  "Tottenham",
  "West Ham",
  "Wolves",
];

/** The recorded injuries envelope committed under src/workers/__fixtures__ is a 2024 pull. */
const RECORDED_FIXTURE_SEASON_YEAR = 2024;

/** Enough rounds to cover "already played", "playing now", "next up" and "later" without
 * generating a whole 38-week season nobody will click through. */
const COMPLETED_GAMEWEEK_COUNT = 2;
const UPCOMING_GAMEWEEK_COUNT = 3;

const DAYS_UNTIL_CURRENT_GAMEWEEK_KICKOFF = 3;
/** How long ago the deliberately-locked club's match kicked off. Long enough to be unambiguously
 * in the past, short enough that the match still reads as in progress. */
const MINUTES_SINCE_LOCKED_MATCH_KICKOFF = 20;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const STARTERS_BY_POSITION: Record<PlayerPosition, number> = { GK: 1, DEF: 4, MID: 4, FWD: 2 };
const SQUAD_PICKS_BY_POSITION: Record<PlayerPosition, number> = { GK: 2, DEF: 5, MID: 5, FWD: 4 };
const SEEDED_TEAM_FORMATION: StartingFormation = "4-4-2";

/** Fixed-seed PRNG (mulberry32) — every run produces the same "random" scorelines, scorers and
 * squads, so a bug found against seeded data can be reproduced by re-running the seed. */
function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomIntegerBelow(random: () => number, exclusiveUpperBound: number): number {
  return Math.floor(random() * exclusiveUpperBound);
}

/**
 * One round of a round-robin over the 20 clubs (circle method: club 0 stays put, the rest rotate),
 * so every club plays exactly once per gameweek and faces a different opponent each round. Home and
 * away swap on alternate rounds so no club is permanently at home.
 */
function buildFixturePairingsForRound(clubs: string[], roundIndex: number): { homeClub: string; awayClub: string }[] {
  const [anchorClub, ...rotatingClubs] = clubs;
  const rotationOffset = roundIndex % rotatingClubs.length;
  const rotated = [...rotatingClubs.slice(rotationOffset), ...rotatingClubs.slice(0, rotationOffset)];
  const orderedClubs = [anchorClub!, ...rotated];

  const pairings: { homeClub: string; awayClub: string }[] = [];
  for (let slotIndex = 0; slotIndex < orderedClubs.length / 2; slotIndex++) {
    const firstClub = orderedClubs[slotIndex]!;
    const secondClub = orderedClubs[orderedClubs.length - 1 - slotIndex]!;
    pairings.push(
      roundIndex % 2 === 0
        ? { homeClub: firstClub, awayClub: secondClub }
        : { homeClub: secondClub, awayClub: firstClub },
    );
  }
  return pairings;
}

/**
 * Whether a player row is one a current-season roster import would produce: a current Premier
 * League club, and a numeric provider id. The external-id test is what excludes rows left behind by
 * older seeds (`mock-player-01`, `stat-seed-…`) — several of them carry real club names, so club
 * alone would keep "Mock MID Five" in a Tottenham shirt sitting in player discovery.
 */
function isCurrentSeasonSquadMember(player: Player): boolean {
  return (
    CURRENT_SEASON_PREMIER_LEAGUE_CLUBS.includes(player.club) &&
    player.externalId !== null &&
    /^\d+$/.test(player.externalId)
  );
}

function groupPlayersByClub(players: Player[]): Map<string, Player[]> {
  const playersByClub = new Map<string, Player[]>();
  for (const player of players) {
    const clubPlayers = playersByClub.get(player.club) ?? [];
    clubPlayers.push(player);
    playersByClub.set(player.club, clubPlayers);
  }
  return playersByClub;
}

/** A club's matchday squad: the most expensive player at each position starts (price is the best
 * proxy for quality we hold), with the next few named as unused-or-late substitutes. */
function selectMatchdaySquad(clubPlayers: Player[]): { starters: Player[]; substitutes: Player[] } {
  const starters: Player[] = [];
  const substitutes: Player[] = [];

  for (const position of ["GK", "DEF", "MID", "FWD"] as PlayerPosition[]) {
    const byDescendingPrice = clubPlayers
      .filter((player) => player.position === position)
      .sort((left, right) => right.priceInMillions - left.priceInMillions);
    starters.push(...byDescendingPrice.slice(0, STARTERS_BY_POSITION[position]));
    substitutes.push(...byDescendingPrice.slice(STARTERS_BY_POSITION[position], STARTERS_BY_POSITION[position] + 1));
  }

  return { starters, substitutes };
}

interface GeneratedMatchPlay {
  stats: PlayerMatchStat[];
  goalEvents: MatchGoalEvent[];
}

/**
 * Invents a plausible match: a scoreline, who scored and when, who assisted, saves, and a scatter
 * of cards — written in exactly the shape `importMatchData` would have written, so the real
 * scoring pipeline (including the game-state goal bonus, which needs an ordered goal timeline) runs
 * against it unchanged.
 */
function generateMatchPlay(
  match: Match,
  homeSquad: { starters: Player[]; substitutes: Player[] },
  awaySquad: { starters: Player[]; substitutes: Player[] },
  random: () => number,
): GeneratedMatchPlay {
  const goalEvents: MatchGoalEvent[] = [];
  const goalsScoredByPlayerId = new Map<string, number>();
  const assistsByPlayerId = new Map<string, number>();

  const scoringSides = [
    { club: match.homeClub, goals: match.finalHomeScore ?? 0, squad: homeSquad },
    { club: match.awayClub, goals: match.finalAwayScore ?? 0, squad: awaySquad },
  ];

  for (const side of scoringSides) {
    // Attackers score most goals, so weight the pool towards them by listing them twice.
    const attackers = side.squad.starters.filter((player) => player.position === "FWD" || player.position === "MID");
    const scorerPool = [...attackers, ...attackers, ...side.squad.starters];

    for (let goalIndex = 0; goalIndex < side.goals; goalIndex++) {
      const scorer = scorerPool[randomIntegerBelow(random, scorerPool.length)]!;
      const assistCandidates = side.squad.starters.filter((player) => player.id !== scorer.id);
      const assister = random() < 0.6 ? assistCandidates[randomIntegerBelow(random, assistCandidates.length)]! : null;

      goalsScoredByPlayerId.set(scorer.id, (goalsScoredByPlayerId.get(scorer.id) ?? 0) + 1);
      if (assister) assistsByPlayerId.set(assister.id, (assistsByPlayerId.get(assister.id) ?? 0) + 1);

      goalEvents.push({
        id: randomUUID(),
        matchId: match.id,
        scorerPlayerId: scorer.id,
        assistPlayerId: assister?.id ?? null,
        beneficiaryClub: side.club,
        goalType: random() < 0.12 ? "PENALTY" : "NORMAL",
        elapsedMinute: 1 + randomIntegerBelow(random, 90),
        addedTimeMinute: 0,
        sequenceIndex: 0,
      });
    }
  }

  // The bonus walks the scoreline in order, so the timeline must be chronological and every event
  // must carry its final position in it.
  goalEvents.sort((left, right) => left.elapsedMinute - right.elapsedMinute);
  goalEvents.forEach((goalEvent, index) => {
    goalEvent.sequenceIndex = index;
  });

  const stats: PlayerMatchStat[] = [];
  for (const side of scoringSides) {
    const opposingSide = scoringSides.find((other) => other.club !== side.club)!;
    for (const player of side.squad.starters) {
      stats.push({
        id: randomUUID(),
        matchId: match.id,
        playerId: player.id,
        // A couple of starters come off before full time.
        minutesPlayed: random() < 0.25 ? 55 + randomIntegerBelow(random, 30) : 90,
        goalsScored: goalsScoredByPlayerId.get(player.id) ?? 0,
        assists: assistsByPlayerId.get(player.id) ?? 0,
        savesCount: player.position === "GK" ? Math.max(0, opposingSide.goals + randomIntegerBelow(random, 5)) : 0,
        ownGoalsScored: 0,
        penaltiesWon: 0,
        penaltiesConceded: 0,
        receivedYellowCard: random() < 0.15,
        receivedRedCard: random() < 0.02,
        wasInStartingLineup: true,
      });
    }
    for (const player of side.squad.substitutes) {
      stats.push({
        id: randomUUID(),
        matchId: match.id,
        playerId: player.id,
        minutesPlayed: random() < 0.5 ? randomIntegerBelow(random, 30) : 0,
        goalsScored: 0,
        assists: 0,
        savesCount: 0,
        ownGoalsScored: 0,
        penaltiesWon: 0,
        penaltiesConceded: 0,
        receivedYellowCard: false,
        receivedRedCard: false,
        wasInStartingLineup: false,
      });
    }
  }

  return { stats, goalEvents };
}

/**
 * Picks a legal 16-man squad the way a manager would: the required count at each position, at most
 * MAX_PLAYERS_PER_CLUB from any one club, inside the £110M budget, and spending on the best
 * available first rather than filling up with whoever is cheapest.
 *
 * Each pool is walked most-expensive-first from a per-team offset, so no two teams end up with the
 * same squad. Every pick has to leave enough budget for the cheapest legal player at each slot
 * still to be filled — without that reserve, a descending walk buys three strikers and then can't
 * afford a goalkeeper.
 */
function selectAffordableSquad(
  playersByDescendingPricePerPosition: Record<PlayerPosition, Player[]>,
  cheapestPriceByPosition: Record<PlayerPosition, number>,
  teamIndex: number,
): Player[] | null {
  const selected: Player[] = [];
  const selectedPlayerIds = new Set<string>();
  const countsByClub = new Map<string, number>();
  const remainingPicksByPosition = { ...SQUAD_PICKS_BY_POSITION };
  let remainingBudgetInMillions = STARTING_SQUAD_BUDGET_IN_MILLIONS;

  for (const position of ["GK", "DEF", "MID", "FWD"] as PlayerPosition[]) {
    const positionPool = playersByDescendingPricePerPosition[position];
    for (let pickIndex = 0; pickIndex < SQUAD_PICKS_BY_POSITION[position]; pickIndex++) {
      remainingPicksByPosition[position]--;
      const budgetToReserveForLaterPicks = (Object.keys(remainingPicksByPosition) as PlayerPosition[]).reduce(
        (reserved, laterPosition) =>
          reserved + remainingPicksByPosition[laterPosition] * cheapestPriceByPosition[laterPosition],
        0,
      );
      const affordableCeiling = remainingBudgetInMillions - budgetToReserveForLaterPicks;

      const rotationStart = (teamIndex * 7 + pickIndex * 13) % positionPool.length;
      const rotated = [...positionPool.slice(rotationStart), ...positionPool.slice(0, rotationStart)];
      const picked = rotated.find(
        (player) =>
          !selectedPlayerIds.has(player.id) &&
          (countsByClub.get(player.club) ?? 0) < MAX_PLAYERS_PER_CLUB &&
          player.priceInMillions <= affordableCeiling,
      );
      if (!picked) return null;

      selected.push(picked);
      selectedPlayerIds.add(picked.id);
      countsByClub.set(picked.club, (countsByClub.get(picked.club) ?? 0) + 1);
      remainingBudgetInMillions -= picked.priceInMillions;
    }
  }

  return selected;
}

/** Starters first, in the order 4-4-2 needs them, so the roster's isStarting flags derive the
 * formation the team is about to be given. */
function buildRosterSlots(squad: Player[]): TeamRosterSlot[] {
  const startingPlayerIds = new Set<string>();
  for (const position of ["GK", "DEF", "MID", "FWD"] as PlayerPosition[]) {
    squad
      .filter((player) => player.position === position)
      .slice(0, STARTERS_BY_POSITION[position])
      .forEach((player) => startingPlayerIds.add(player.id));
  }
  return squad.map((player) => ({ playerId: player.id, isStarting: startingPlayerIds.has(player.id) }));
}

// ─── Stages ────────────────────────────────────────────────────────────────────

/**
 * Stage 1: leave discovery showing exactly what a *complete* roster import would leave showing —
 * the current Premier League squads and nothing else. Rows are only ever hidden, never deleted;
 * historic scores keep pointing at them.
 *
 * Restores visibility as well as removing it. The production sweep
 * (`hidePlayersOutsideCurrentSeasonSquads`) deliberately only hides — a player becomes visible
 * again by turning up in a real import, one upserted row at a time — so a local database that was
 * swept after a partial import ends up with whole clubs wrongly hidden and no way back. Correcting
 * that is exactly this script's job, hence the direct write.
 */
async function applyCurrentSeasonSquadVisibility(): Promise<{ hiddenCount: number; restoredCount: number }> {
  const currentSquadExternalIds = (await playersRepository.findMany({}))
    .filter((player) => isCurrentSeasonSquadMember(player))
    .map((player) => player.externalId!);

  const restored = await db
    .update(playersTable)
    .set({ isInCurrentSeasonSquad: true, updatedAt: new Date() })
    .where(
      and(
        eq(playersTable.isInCurrentSeasonSquad, false),
        inArray(playersTable.externalId, currentSquadExternalIds),
      ),
    )
    .returning({ id: playersTable.id });

  const hiddenCount = await playersRepository.hidePlayersOutsideCurrentSeasonSquads(currentSquadExternalIds);

  return { hiddenCount, restoredCount: restored.length };
}

/** Stage 2: real injuries, no quota spent — the production importer driven by the recorded
 * provider envelope in src/workers/__fixtures__ instead of the live API. */
async function syncAvailabilityFromRecordedFixture(): Promise<string> {
  try {
    await importPlayerAvailability(new OfflineFootballDataProvider(RECORDED_FIXTURE_SEASON_YEAR));
    const visiblePlayers = await playersRepository.findMany({ onlyInCurrentSeasonSquad: true });
    const out = visiblePlayers.filter((player) => player.availabilityStatus === "OUT").length;
    const doubtful = visiblePlayers.filter((player) => player.availabilityStatus === "QUESTIONABLE").length;
    return `${out} out, ${doubtful} doubtful`;
  } catch (error) {
    return `skipped — no recorded injuries fixture (run npm run record:fixtures): ${(error as Error).message}`;
  }
}

/** Reset stage: everything derived from fixtures, in foreign-key order. Deliberately not a
 * repository function — nothing in the running application should be able to wipe a season. */
async function deleteAllFixtureAndScoringData(): Promise<void> {
  await db.delete(leagueStandingsTable);
  await db.delete(teamScoresTable);
  await db.delete(playerScoresTable);
  await db.delete(matchGoalEventsTable);
  await db.delete(playerMatchStatsTable);
  await db.delete(transfersTable);
  await db.delete(matchesTable);
  await db.delete(gameweeksTable);
}

interface SeededGameweek {
  id: string;
  number: number;
  status: "COMPLETED" | "UPCOMING";
  firstKickoffAt: Date;
  matchIds: string[];
}

/**
 * Reset stage: a five-round season over the current 20 clubs — two rounds already played and
 * scored, the current round starting in three days, two rounds after that. One match in the
 * current round is set to have kicked off minutes ago, which is the only way to exercise the
 * locked-player paths (greyed discovery rows, disabled captaincy options, the partial-apply save
 * warning) on demand.
 */
async function rebuildSeason(
  playersByClub: Map<string, Player[]>,
  random: () => number,
): Promise<{ gameweeks: SeededGameweek[]; lockedClubs: string[] }> {
  const now = Date.now();
  const seededGameweeks: SeededGameweek[] = [];
  let lockedClubs: string[] = [];

  const totalGameweeks = COMPLETED_GAMEWEEK_COUNT + UPCOMING_GAMEWEEK_COUNT;
  for (let roundIndex = 0; roundIndex < totalGameweeks; roundIndex++) {
    const gameweekNumber = roundIndex + 1;
    const isCompleted = roundIndex < COMPLETED_GAMEWEEK_COUNT;
    const isCurrent = roundIndex === COMPLETED_GAMEWEEK_COUNT;

    // Completed rounds sit a week apart behind us; the current round is three days out, with each
    // later round a week further on.
    const daysFromNow = isCompleted
      ? -((COMPLETED_GAMEWEEK_COUNT - roundIndex) * 7)
      : DAYS_UNTIL_CURRENT_GAMEWEEK_KICKOFF + (roundIndex - COMPLETED_GAMEWEEK_COUNT) * 7;
    const nominalFirstKickoffAt = new Date(now + daysFromNow * MILLISECONDS_PER_DAY);

    const pairings = buildFixturePairingsForRound(CURRENT_SEASON_PREMIER_LEAGUE_CLUBS, roundIndex);
    const scheduledPairings = pairings.map((pairing, pairingIndex) => {
      // The first fixture of the current round is already under way, locking its two clubs.
      const isAlreadyKickedOff = isCurrent && pairingIndex === 0;
      return {
        ...pairing,
        isAlreadyKickedOff,
        kickoffAt: isAlreadyKickedOff
          ? new Date(now - MINUTES_SINCE_LOCKED_MATCH_KICKOFF * 60 * 1000)
          : new Date(nominalFirstKickoffAt.getTime() + pairingIndex * 2 * 60 * 60 * 1000),
      };
    });

    // A gameweek's deadline is its earliest kickoff, so the already-kicked-off fixture has to be
    // taken into account — otherwise the round advertises a deadline three days out while one of
    // its matches is being played.
    const firstKickoffAt = scheduledPairings.reduce(
      (earliest, pairing) => (pairing.kickoffAt < earliest ? pairing.kickoffAt : earliest),
      scheduledPairings[0]!.kickoffAt,
    );
    const gameweek = await gameweeksRepository.upsertByNumber(gameweekNumber, firstKickoffAt);
    const matchIds: string[] = [];

    for (const [pairingIndex, pairing] of scheduledPairings.entries()) {
      const { isAlreadyKickedOff, kickoffAt } = pairing;

      const match: Match = {
        id: randomUUID(),
        externalId: `seed-gw${gameweekNumber}-match-${pairingIndex + 1}`,
        gameweekId: gameweek.id,
        homeClub: pairing.homeClub,
        awayClub: pairing.awayClub,
        kickoffAt,
        status: isCompleted ? "COMPLETED" : isAlreadyKickedOff ? "IN_PROGRESS" : "SCHEDULED",
        finalHomeScore: isCompleted ? randomIntegerBelow(random, 4) : null,
        finalAwayScore: isCompleted ? randomIntegerBelow(random, 4) : null,
      };
      await matchesRepository.upsert(match);
      matchIds.push(match.id);
      if (isAlreadyKickedOff) lockedClubs = [pairing.homeClub, pairing.awayClub];

      if (isCompleted) {
        const homeSquad = selectMatchdaySquad(playersByClub.get(pairing.homeClub) ?? []);
        const awaySquad = selectMatchdaySquad(playersByClub.get(pairing.awayClub) ?? []);
        const { stats, goalEvents } = generateMatchPlay(match, homeSquad, awaySquad, random);
        await playerMatchStatsRepository.replaceForMatch(match.id, stats);
        await matchGoalEventsRepository.replaceForMatch(match.id, goalEvents);
      }
    }

    if (isCompleted) await gameweeksRepository.markCompleted(gameweek.id);
    seededGameweeks.push({
      id: gameweek.id,
      number: gameweekNumber,
      status: isCompleted ? "COMPLETED" : "UPCOMING",
      firstKickoffAt,
      matchIds,
    });
  }

  return { gameweeks: seededGameweeks, lockedClubs };
}

/** Reset stage: every local team's roster is refilled from real players. Local teams were built
 * against the old synthetic seed rows, which stage 1 has just hidden — without this they'd load
 * into the squad builder as a squad of players discovery no longer offers. */
async function rebuildTeamRosters(visiblePlayers: Player[]): Promise<{ rebuilt: number; skipped: number }> {
  const playersByPosition: Record<PlayerPosition, Player[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const player of visiblePlayers) playersByPosition[player.position].push(player);
  const cheapestPriceByPosition: Record<PlayerPosition, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const position of Object.keys(playersByPosition) as PlayerPosition[]) {
    playersByPosition[position].sort((left, right) => right.priceInMillions - left.priceInMillions);
    cheapestPriceByPosition[position] = playersByPosition[position].at(-1)?.priceInMillions ?? 0;
  }

  const teams = await teamsRepository.findAll();
  let rebuilt = 0;
  let skipped = 0;

  for (const [teamIndex, team] of teams.entries()) {
    const squad = selectAffordableSquad(playersByPosition, cheapestPriceByPosition, teamIndex);
    const compositionError = squad ? validateSquadComposition(squad) : "no affordable squad available";
    if (!squad || compositionError) {
      console.warn(`seedMock: left ${team.name} untouched — ${compositionError}`);
      skipped++;
      continue;
    }

    const rosterSlots = buildRosterSlots(squad);
    const totalSpentInMillions = squad.reduce((sum, player) => sum + player.priceInMillions, 0);
    await teamsRepository.replaceRosterSlots(
      team.id,
      rosterSlots,
      Number((STARTING_SQUAD_BUDGET_IN_MILLIONS - totalSpentInMillions).toFixed(1)),
    );

    // Captain and vice-captain must be different starters, and the most expensive outfield pair is
    // the pick a manager would most likely make.
    const startingPlayerIds = new Set(rosterSlots.filter((slot) => slot.isStarting).map((slot) => slot.playerId));
    const [captain, viceCaptain] = squad
      .filter((player) => startingPlayerIds.has(player.id) && player.position !== "GK")
      .sort((left, right) => right.priceInMillions - left.priceInMillions);
    await teamsRepository.updateLineup(team.id, {
      formation: SEEDED_TEAM_FORMATION,
      captainPlayerId: captain!.id,
      viceCaptainPlayerId: viceCaptain!.id,
    });
    rebuilt++;
  }

  return { rebuilt, skipped };
}

/** Final stage in both modes: the real pipeline, exactly as the workers run it in production. */
async function recomputeScores(completedGameweeks: { id: string; matchIds: string[] }[]): Promise<string[]> {
  for (const gameweek of completedGameweeks) {
    for (const matchId of gameweek.matchIds) await calculatePlayerScores(matchId);
    await calculateTeamScores(gameweek.id);
  }

  const leagues = await leaguesRepository.findAll();
  for (const league of leagues) {
    for (const gameweek of completedGameweeks) await updateStandings(league.id, gameweek.id);
  }
  return leagues.map((league) => league.id);
}

/**
 * Default-mode fallback for the fixture dates: the gameweek that is actually current (lowest-
 * numbered not-yet-COMPLETED) has its kickoffs pushed far enough forward that nothing is locked.
 * A hardcoded gameweek number doesn't work here — upsertByNumber never resets status on conflict,
 * so targeting an already-COMPLETED gameweek would never make it current.
 */
async function pushCurrentGameweekIntoFuture(): Promise<string> {
  const currentGameweek = await gameweeksRepository.findCurrent();
  if (!currentGameweek) return "no current gameweek found — nothing to reschedule";

  const gameweekMatches = await matchesRepository.findByGameweekId(currentGameweek.id);
  if (gameweekMatches.length === 0) return `gameweek ${currentGameweek.number} has no fixtures to reschedule`;

  const earliestKickoffAt = gameweekMatches.reduce(
    (earliest, match) => (match.kickoffAt < earliest ? match.kickoffAt : earliest),
    gameweekMatches[0]!.kickoffAt,
  );
  const targetFirstKickoffAt = new Date(Date.now() + DAYS_UNTIL_CURRENT_GAMEWEEK_KICKOFF * MILLISECONDS_PER_DAY);
  const offsetDays = Math.ceil((targetFirstKickoffAt.getTime() - earliestKickoffAt.getTime()) / MILLISECONDS_PER_DAY);
  const newFirstKickoffAt = new Date(earliestKickoffAt.getTime() + offsetDays * MILLISECONDS_PER_DAY);

  await matchesRepository.rescheduleGameweekIntoFuture(currentGameweek.id, offsetDays);
  await gameweeksRepository.reopenForTesting(currentGameweek.id, newFirstKickoffAt);
  return `gameweek ${currentGameweek.number} reopened, first kickoff ${newFirstKickoffAt.toISOString()}`;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (!isLocalDatabaseUrl(connectionString)) {
    throw new Error(
      "seed:mock refuses to run: DATABASE_URL does not point at localhost. This script rewrites " +
        "player visibility, fixtures and team rosters, and is for local development only.",
    );
  }

  const shouldReset = process.argv.includes("--reset");
  const random = createDeterministicRandom(20260820);

  const visibility = await applyCurrentSeasonSquadVisibility();
  const availabilitySummary = await syncAvailabilityFromRecordedFixture();
  const visiblePlayers = await playersRepository.findMany({ onlyInCurrentSeasonSquad: true });

  if (!shouldReset) {
    const rescheduleSummary = await pushCurrentGameweekIntoFuture();
    console.log(
      JSON.stringify(
        {
          mode: "default (non-destructive) — re-run with `-- --reset` for a prod-like rebuild",
          playersHiddenFromDiscovery: visibility.hiddenCount,
          playersRestoredToDiscovery: visibility.restoredCount,
          playersVisibleInDiscovery: visiblePlayers.length,
          availability: availabilitySummary,
          fixtures: rescheduleSummary,
        },
        null,
        2,
      ),
    );
    return;
  }

  const playersByClub = groupPlayersByClub(visiblePlayers);
  const clubsWithoutEnoughPlayers = CURRENT_SEASON_PREMIER_LEAGUE_CLUBS.filter(
    (club) => (playersByClub.get(club) ?? []).length < SQUAD_SIZE,
  );
  if (clubsWithoutEnoughPlayers.length > 0) {
    throw new Error(
      `seed:mock --reset needs a full local roster first (npm run hydrate:roster). Thin squads: ${clubsWithoutEnoughPlayers.join(", ")}`,
    );
  }

  await deleteAllFixtureAndScoringData();
  const season = await rebuildSeason(playersByClub, random);
  const rosters = await rebuildTeamRosters(visiblePlayers);
  const scoredLeagueIds = await recomputeScores(season.gameweeks.filter((gameweek) => gameweek.status === "COMPLETED"));

  console.log(
    JSON.stringify(
      {
        mode: "--reset (fixtures, scores, transfers and team rosters rebuilt)",
        playersHiddenFromDiscovery: visibility.hiddenCount,
        playersRestoredToDiscovery: visibility.restoredCount,
        playersVisibleInDiscovery: visiblePlayers.length,
        goalkeepersRequiredPerSquad: REQUIRED_GOALKEEPER_COUNT,
        availability: availabilitySummary,
        gameweeks: season.gameweeks.map((gameweek) => ({
          number: gameweek.number,
          status: gameweek.status,
          firstKickoffAt: gameweek.firstKickoffAt,
          matchCount: gameweek.matchIds.length,
        })),
        lockedClubs: season.lockedClubs,
        teamRosters: rosters,
        leaguesWithRecomputedStandings: scoredLeagueIds,
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
