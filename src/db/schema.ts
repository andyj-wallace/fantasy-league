import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Mirrors PlayerPosition in src/domain/shared.ts. */
export const playerPositionEnum = pgEnum("player_position", ["GK", "DEF", "MID", "FWD"]);

/** Mirrors StartingFormation in src/domain/shared.ts. */
export const startingFormationEnum = pgEnum("starting_formation", [
  "3-4-3",
  "3-5-2",
  "4-3-3",
  "4-4-2",
  "4-5-1",
  "5-3-2",
  "5-4-1",
]);

/** Mirrors MatchStatus in src/domain/shared.ts. */
export const matchStatusEnum = pgEnum("match_status", [
  "SCHEDULED",
  "IN_PROGRESS",
  "COMPLETED",
  "POSTPONED",
  "VOIDED",
  "DELAYED",
  "INTERRUPTED",
]);

/** Mirrors GameweekStatus in src/domain/shared.ts. */
export const gameweekStatusEnum = pgEnum("gameweek_status", [
  "UPCOMING",
  "LOCKED",
  "IN_PROGRESS",
  "COMPLETED",
]);

/** Mirrors PlayerAvailabilityStatus in src/domain/shared.ts. Cosmetic only — see Fantasy League Architecture.txt. */
export const playerAvailabilityStatusEnum = pgEnum("player_availability_status", [
  "AVAILABLE",
  "OUT",
  "QUESTIONABLE",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    /** Immutable Cognito account id (`sub` claim) — stable identity link; null pre-Cognito. */
    cognitoSub: text("cognito_sub").unique(),
    /** Unique login handle (the Cognito username) — unique case-insensitively, matching the
     * pool's CaseSensitive=false username configuration. Null for local-dev users. */
    handle: text("handle"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_handle_lower_idx").on(sql`lower(${table.handle})`)],
);

export const leagues = pgTable("leagues", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  inviteCode: text("invite_code").notNull().unique(),
  commissionerUserId: uuid("commissioner_user_id")
    .notNull()
    .references(() => users.id),
  areSettingsLocked: boolean("are_settings_locked").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const gameweeks = pgTable("gameweeks", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: integer("number").notNull().unique(),
  deadlineAt: timestamp("deadline_at").notNull(),
  status: gameweekStatusEnum("status").notNull(),
});

export const players = pgTable("players", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The football data provider's player ID — null until the roster importer links this row to
  // a provider record; used to attribute imported PlayerMatchStat/injury rows to the right Player.
  externalId: text("external_id").unique(),
  name: text("name").notNull(),
  club: text("club").notNull(),
  position: playerPositionEnum("position").notNull(),
  priceInMillions: real("price_in_millions").notNull(),
  availabilityStatus: playerAvailabilityStatusEnum("availability_status").notNull().default("AVAILABLE"),
  // Raw provider text ("Knee Injury", "Suspended", ...) for tooltip/label display — kept separate
  // from the enum rather than string-matched into it (fragile across providers/leagues).
  availabilityReason: text("availability_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const matches = pgTable("matches", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The football data provider's fixture ID — set as soon as the importer first sees this
  // fixture; lets later polls upsert by provider identity instead of our internal uuid.
  externalId: text("external_id").unique(),
  gameweekId: uuid("gameweek_id")
    .notNull()
    .references(() => gameweeks.id),
  homeClub: text("home_club").notNull(),
  awayClub: text("away_club").notNull(),
  kickoffAt: timestamp("kickoff_at").notNull(),
  status: matchStatusEnum("status").notNull(),
  finalHomeScore: integer("final_home_score"),
  finalAwayScore: integer("final_away_score"),
});

/**
 * Singleton row (one ever exists) tracking when each gated, budget-sensitive provider poll last
 * ran, so the worker cycle can stay under the provider's 100-requests/day cap. See polling-budget.md.
 */
export const providerPollState = pgTable("provider_poll_state", {
  id: uuid("id").primaryKey().defaultRandom(),
  lastDiscoveryRanAt: timestamp("last_discovery_ran_at"),
  lastRosterImportRanAt: timestamp("last_roster_import_ran_at"),
  lastAvailabilitySyncRanAt: timestamp("last_availability_sync_ran_at"),
  /** Computed by the live-polling tick from the quota-status formula; the tick no-ops until now() reaches this. */
  nextLivePollDueAt: timestamp("next_live_poll_due_at"),
  /** Set monthly by fetchLeagueCurrentSeason — the API-Football year (e.g. 2026 = 2026-27 season). */
  currentSeasonYear: integer("current_season_year"),
  /** Whether /fixtures/players stats are available for currentSeasonYear. Gates fetchFixturePlayerStats. */
  coverageFixturePlayerStats: boolean("coverage_fixture_player_stats").notNull().default(false),
  /** Whether the /injuries endpoint is populated for currentSeasonYear. Gates fetchInjuries. */
  coverageInjuries: boolean("coverage_injuries").notNull().default(false),
  lastSeasonSyncRanAt: timestamp("last_season_sync_ran_at"),
});

/**
 * A "confirmation pass" owed ~45-60 min after a Match reaches COMPLETED, to catch late VAR
 * corrections per the Live-Match Polling Strategy in Fantasy League Architecture.txt. Persisted
 * (not in-memory) so it survives both Lambda's stateless invocations and local process restarts.
 */
export const pendingConfirmationPasses = pgTable("pending_confirmation_passes", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchId: uuid("match_id")
    .notNull()
    .references(() => matches.id),
  externalFixtureId: text("external_fixture_id").notNull(),
  dueAt: timestamp("due_at").notNull(),
});

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    // Nullable: a Team exists from the moment a manager joins a league, before they've built a
    // squad — formation/captain/vice-captain aren't chosen until the squad builder flow runs.
    formation: startingFormationEnum("formation"),
    captainPlayerId: uuid("captain_player_id").references(() => players.id),
    viceCaptainPlayerId: uuid("vice_captain_player_id").references(() => players.id),
    remainingBudgetInMillions: real("remaining_budget_in_millions").notNull(),
    bankedFreeTransferCount: integer("banked_free_transfer_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    // Null means the manager is active. Set when a commissioner removes a manager — the Team row
    // (and its historical teamScores/leagueStandings/transfers) is never deleted, only hidden from
    // active-team reads, so removal can't corrupt or gap already-computed standings. A later rejoin
    // by the same user in the same league revives this same row instead of inserting a duplicate.
    removedAt: timestamp("removed_at"),
  },
  // Exactly one Team per user per league — the DB backstop for a double-submitted joinLeague
  // (the handler also uses insertOrRevive, but this makes the guarantee race-proof). Deliberately
  // NOT partial/filtered on removedAt: insertOrRevive's ON CONFLICT target depends on this index
  // still covering soft-removed rows so a rejoin conflicts with (and revives) the old row instead
  // of inserting a second one.
  (table) => [uniqueIndex("teams_league_id_user_id_idx").on(table.leagueId, table.userId)],
);

/** One row per player on a Team's 16-man roster; isStarting distinguishes the XI from the bench. */
export const teamRosterSlots = pgTable("team_roster_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  playerId: uuid("player_id")
    .notNull()
    .references(() => players.id),
  isStarting: boolean("is_starting").notNull(),
});

export const transfers = pgTable("transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  gameweekId: uuid("gameweek_id")
    .notNull()
    .references(() => gameweeks.id),
  playerOutId: uuid("player_out_id")
    .notNull()
    .references(() => players.id),
  playerInId: uuid("player_in_id")
    .notNull()
    .references(() => players.id),
  pointsCost: integer("points_cost").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const playerMatchStats = pgTable("player_match_stats", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchId: uuid("match_id")
    .notNull()
    .references(() => matches.id),
  playerId: uuid("player_id")
    .notNull()
    .references(() => players.id),
  minutesPlayed: integer("minutes_played").notNull(),
  goalsScored: integer("goals_scored").notNull().default(0),
  assists: integer("assists").notNull().default(0),
  savesCount: integer("saves_count").notNull().default(0),
  ownGoalsScored: integer("own_goals_scored").notNull().default(0),
  penaltiesWon: integer("penalties_won").notNull().default(0),
  penaltiesConceded: integer("penalties_conceded").notNull().default(0),
  receivedYellowCard: boolean("received_yellow_card").notNull().default(false),
  receivedRedCard: boolean("received_red_card").notNull().default(false),
});

/** breakdown/tiebreakerStats are stored as jsonb, matching the plain object shape of the domain type. */
export const playerScores = pgTable(
  "player_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    gameweekId: uuid("gameweek_id")
      .notNull()
      .references(() => gameweeks.id),
    breakdown: jsonb("breakdown").notNull(),
    totalPoints: integer("total_points").notNull(),
    calculatedAt: timestamp("calculated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("player_scores_player_id_match_id_idx").on(table.playerId, table.matchId),
  ],
);

export const teamScores = pgTable("team_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  gameweekId: uuid("gameweek_id")
    .notNull()
    .references(() => gameweeks.id),
  captainBonusPlayerId: uuid("captain_bonus_player_id").references(() => players.id),
  totalPoints: integer("total_points").notNull(),
  calculatedAt: timestamp("calculated_at").notNull().defaultNow(),
});

export const leagueStandings = pgTable("league_standings", {
  id: uuid("id").primaryKey().defaultRandom(),
  leagueId: uuid("league_id")
    .notNull()
    .references(() => leagues.id),
  gameweekId: uuid("gameweek_id")
    .notNull()
    .references(() => gameweeks.id),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id),
  rank: integer("rank").notNull(),
  totalPoints: integer("total_points").notNull(),
  tiebreakerStats: jsonb("tiebreaker_stats").notNull(),
  calculatedAt: timestamp("calculated_at").notNull().defaultNow(),
});
