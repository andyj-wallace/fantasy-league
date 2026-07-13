import type { PlayerPosition } from "../../domain";

/**
 * The scripted gameweek-lifecycle scenario behind `npm run smoke:recorded` — one gameweek played
 * forward through six checkpoints, exercising per-club kickoff locking, mid-gameweek transfers,
 * a postponement (with its banked-transfer award), a cross-gameweek early kickoff, the
 * captain-didn't-play vice-captain fallback, and the completion cascade that finalizes standings.
 *
 * There is no clock abstraction in the app, so the harness never fakes the clock. Instead every
 * event carries a VIRTUAL time (hours from T0 = Thursday 18:00), and at each checkpoint the
 * scripted provider re-emits every fixture with its kickoff converted to a real timestamp:
 *
 *   realEventTime = realNow - (virtualNow - virtualEventTime)
 *
 * so the real wall-clock "now" always lands exactly at the checkpoint's virtual moment. All
 * Match/Gameweek rows are then created and mutated by the real import pipeline
 * (importMatchData -> processMatchDataChanges), never written directly.
 */

// ─── Virtual timeline (hours from T0 = Thursday 18:00) ──────────────────────────

export const VIRTUAL_HOURS = {
  matchFridayKickoff: 26, // Fri 20:00 — Arsenal v Chelsea (GW1)
  matchSaturdayKickoff: 45, // Sat 15:00 — Liverpool v Man City (GW1)
  matchSundayOriginalKickoff: 68, // Sun 14:00 — Spurs v Newcastle (GW1, postponed before kickoff)
  matchSundayReplayKickoff: 145, // Wed 19:00 — the rescheduled Spurs v Newcastle
  matchMondayKickoff: 98, // Mon 20:00 — Aston Villa v Brighton (GW1)
  earlyNextGameweekKickoff: 64, // Sun 10:00 — Aston Villa v Spurs (GW2! kicks off before GW1 ends)
  nextGameweekNormalKickoff: 213, // next Sat 15:00 — Chelsea v Man City (GW2, never played here)
} as const;

export const CHECKPOINT_IDS = ["A", "B", "C", "D", "E", "F"] as const;
export type CheckpointId = (typeof CHECKPOINT_IDS)[number];

export interface ScenarioCheckpoint {
  id: CheckpointId;
  label: string;
  virtualNowHours: number;
}

export const SCENARIO_CHECKPOINTS: ScenarioCheckpoint[] = [
  { id: "A", label: "Pre-gameweek: everything scheduled, nobody locked", virtualNowHours: 0 }, // Thu 18:00
  { id: "B", label: "Friday match in play: Arsenal/Chelsea locked, others transferable", virtualNowHours: 26.5 }, // Fri 20:30
  { id: "C", label: "Saturday done: two matches full time, no standings yet", virtualNowHours: 49 }, // Sat 19:00
  { id: "D", label: "Sunday: postponement announced + early GW2 match already played", virtualNowHours: 66 }, // Sun 12:00
  { id: "E", label: "Monday finished, but postponed match holds Gameweek 1 open", virtualNowHours: 100.5 }, // Mon 22:30
  { id: "F", label: "Postponed match replayed Wednesday: Gameweek 1 completes", virtualNowHours: 147 }, // Wed 21:00
];

export function findCheckpoint(id: CheckpointId): ScenarioCheckpoint {
  return SCENARIO_CHECKPOINTS.find((checkpoint) => checkpoint.id === id)!;
}

/** The virtual->real conversion described in the module doc. */
export function toRealTime(virtualNowHours: number, virtualEventHours: number, realNow: Date): Date {
  return new Date(realNow.getTime() - (virtualNowHours - virtualEventHours) * 60 * 60 * 1000);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────────

/** A fixture's provider-visible state as of one checkpoint. */
export interface ScenarioFixtureSnapshot {
  /** API-Football short code — NS/1H/FT/PST, mapped by footballMatchStatusMapping.ts. */
  statusShortCode: string;
  kickoffVirtualHours: number;
  finalHomeScore: number | null;
  finalAwayScore: number | null;
}

export interface ScenarioFixture {
  externalId: string;
  /** Parsed into the Gameweek number by importMatchData — this is what decides membership. */
  roundLabel: string;
  homeClub: string;
  awayClub: string;
  /** Ordered checkpoint states; a checkpoint uses the latest entry at or before it. */
  timeline: Partial<Record<CheckpointId, ScenarioFixtureSnapshot>>;
}

function snapshot(
  statusShortCode: string,
  kickoffVirtualHours: number,
  finalHomeScore: number | null = null,
  finalAwayScore: number | null = null,
): ScenarioFixtureSnapshot {
  return { statusShortCode, kickoffVirtualHours, finalHomeScore, finalAwayScore };
}

export const SCENARIO_FIXTURES: ScenarioFixture[] = [
  {
    externalId: "recsmoke-m1-arsenal-chelsea",
    roundLabel: "Regular Season - 1",
    homeClub: "Arsenal",
    awayClub: "Chelsea",
    timeline: {
      A: snapshot("NS", VIRTUAL_HOURS.matchFridayKickoff),
      B: snapshot("1H", VIRTUAL_HOURS.matchFridayKickoff),
      C: snapshot("FT", VIRTUAL_HOURS.matchFridayKickoff, 2, 0),
    },
  },
  {
    externalId: "recsmoke-m2-liverpool-mancity",
    roundLabel: "Regular Season - 1",
    homeClub: "Liverpool",
    awayClub: "Man City",
    timeline: {
      A: snapshot("NS", VIRTUAL_HOURS.matchSaturdayKickoff),
      C: snapshot("FT", VIRTUAL_HOURS.matchSaturdayKickoff, 1, 1),
    },
  },
  {
    externalId: "recsmoke-m3-spurs-newcastle",
    roundLabel: "Regular Season - 1",
    homeClub: "Spurs",
    awayClub: "Newcastle",
    timeline: {
      A: snapshot("NS", VIRTUAL_HOURS.matchSundayOriginalKickoff),
      // Postponement is announced Sunday morning, BEFORE the 14:00 kickoff — kickoff unchanged,
      // which is exactly what API-Football reports until a fixture is rescheduled.
      D: snapshot("PST", VIRTUAL_HOURS.matchSundayOriginalKickoff),
      F: snapshot("FT", VIRTUAL_HOURS.matchSundayReplayKickoff, 1, 0),
    },
  },
  {
    externalId: "recsmoke-m4-villa-brighton",
    roundLabel: "Regular Season - 1",
    homeClub: "Aston Villa",
    awayClub: "Brighton",
    timeline: {
      A: snapshot("NS", VIRTUAL_HOURS.matchMondayKickoff),
      E: snapshot("FT", VIRTUAL_HOURS.matchMondayKickoff, 3, 1),
    },
  },
  {
    // The cross-gameweek case: a GW2 fixture that kicks off (and finishes) on Sunday, before
    // GW1's Monday match — its clubs must NOT lock for GW1 transfers.
    externalId: "recsmoke-m5-villa-spurs",
    roundLabel: "Regular Season - 2",
    homeClub: "Aston Villa",
    awayClub: "Spurs",
    timeline: {
      A: snapshot("NS", VIRTUAL_HOURS.earlyNextGameweekKickoff),
      D: snapshot("FT", VIRTUAL_HOURS.earlyNextGameweekKickoff, 2, 1),
    },
  },
  {
    // Keeps GW2 open after M5 completes (a gameweek with every known match COMPLETED would be
    // marked COMPLETED by processMatchDataChanges). Never kicks off during this scenario.
    externalId: "recsmoke-m6-chelsea-mancity",
    roundLabel: "Regular Season - 2",
    homeClub: "Chelsea",
    awayClub: "Man City",
    timeline: {
      A: snapshot("NS", VIRTUAL_HOURS.nextGameweekNormalKickoff),
    },
  },
];

/** The fixture state the provider reports as of a checkpoint: the latest timeline entry at or
 * before it (fixtures list every change, so this is a simple walk of checkpoint order). */
export function resolveFixtureSnapshot(fixture: ScenarioFixture, checkpointId: CheckpointId): ScenarioFixtureSnapshot {
  let resolved: ScenarioFixtureSnapshot | undefined;
  for (const id of CHECKPOINT_IDS) {
    resolved = fixture.timeline[id] ?? resolved;
    if (id === checkpointId) break;
  }
  if (!resolved) throw new Error(`Fixture ${fixture.externalId} has no snapshot at or before checkpoint ${checkpointId}`);
  return resolved;
}

// ─── Players ─────────────────────────────────────────────────────────────────────

export interface ScenarioPlayer {
  externalId: string;
  name: string;
  club: string;
  position: PlayerPosition;
  /** Only set where the scenario needs a non-default price (to make budget changes visible);
   * everyone else keeps DEFAULT_INITIAL_PRICE_IN_MILLIONS_BY_POSITION (GK/DEF 4.5, MID/FWD 5.5). */
  priceInMillions?: number;
}

function player(externalId: string, name: string, club: string, position: PlayerPosition, priceInMillions?: number): ScenarioPlayer {
  return { externalId, name, club, position, priceInMillions };
}

/** Every player the scenario knows. Names deliberately encode club + position so the recording
 * and the hand-computed expectations below stay legible side by side. */
export const SCENARIO_PLAYERS: ScenarioPlayer[] = [
  // Team Alpha XI's original 16 (2 per club)
  player("recsmoke-arsenal-def-1", "Arsenal DEF 1", "Arsenal", "DEF"),
  player("recsmoke-arsenal-mid-1", "Arsenal MID 1", "Arsenal", "MID"),
  player("recsmoke-chelsea-gk-1", "Chelsea GK 1", "Chelsea", "GK"),
  player("recsmoke-chelsea-fwd-1", "Chelsea FWD 1", "Chelsea", "FWD"),
  player("recsmoke-liverpool-mid-1", "Liverpool MID 1", "Liverpool", "MID"),
  player("recsmoke-liverpool-fwd-1", "Liverpool FWD 1", "Liverpool", "FWD"),
  player("recsmoke-mancity-def-1", "Man City DEF 1", "Man City", "DEF"),
  player("recsmoke-mancity-fwd-1", "Man City FWD 1", "Man City", "FWD"),
  player("recsmoke-spurs-def-1", "Spurs DEF 1", "Spurs", "DEF"),
  player("recsmoke-spurs-mid-1", "Spurs MID 1", "Spurs", "MID"),
  player("recsmoke-newcastle-gk-1", "Newcastle GK 1", "Newcastle", "GK"),
  player("recsmoke-newcastle-def-1", "Newcastle DEF 1", "Newcastle", "DEF"),
  player("recsmoke-villa-mid-1", "Villa MID 1", "Aston Villa", "MID"),
  player("recsmoke-villa-fwd-1", "Villa FWD 1", "Aston Villa", "FWD"),
  player("recsmoke-brighton-def-1", "Brighton DEF 1", "Brighton", "DEF"),
  player("recsmoke-brighton-mid-1", "Brighton MID 1", "Brighton", "MID"),
  // Team Bravo XI's 16 (2 per club, all distinct from Alpha's)
  player("recsmoke-arsenal-gk-1", "Arsenal GK 1", "Arsenal", "GK"),
  player("recsmoke-arsenal-fwd-1", "Arsenal FWD 1", "Arsenal", "FWD"),
  player("recsmoke-chelsea-def-1", "Chelsea DEF 1", "Chelsea", "DEF"),
  player("recsmoke-chelsea-mid-1", "Chelsea MID 1", "Chelsea", "MID"),
  player("recsmoke-liverpool-gk-1", "Liverpool GK 1", "Liverpool", "GK"),
  player("recsmoke-liverpool-def-1", "Liverpool DEF 1", "Liverpool", "DEF"),
  player("recsmoke-mancity-mid-1", "Man City MID 1", "Man City", "MID"),
  player("recsmoke-mancity-fwd-2", "Man City FWD 2", "Man City", "FWD"),
  player("recsmoke-spurs-def-2", "Spurs DEF 2", "Spurs", "DEF"),
  player("recsmoke-spurs-fwd-1", "Spurs FWD 1", "Spurs", "FWD"),
  player("recsmoke-newcastle-mid-2", "Newcastle MID 2", "Newcastle", "MID"),
  player("recsmoke-newcastle-fwd-1", "Newcastle FWD 1", "Newcastle", "FWD"),
  player("recsmoke-villa-def-1", "Villa DEF 1", "Aston Villa", "DEF"),
  player("recsmoke-villa-mid-2", "Villa MID 2", "Aston Villa", "MID"),
  player("recsmoke-brighton-def-2", "Brighton DEF 2", "Brighton", "DEF"),
  player("recsmoke-brighton-mid-2", "Brighton MID 2", "Brighton", "MID"),
  // Transfer targets — priced off the flat defaults so the budget tile visibly moves.
  player("recsmoke-brighton-fwd-1", "Brighton FWD 1", "Brighton", "FWD", 6.5),
  player("recsmoke-newcastle-mid-1", "Newcastle MID 1", "Newcastle", "MID", 5),
  // Unrostered spares so transfer pickers show a real choice, and a legal (unlocked) playerIn
  // for the rejected locked-player transfer attempt.
  player("recsmoke-villa-def-2", "Villa DEF 2", "Aston Villa", "DEF"),
  player("recsmoke-chelsea-mid-2", "Chelsea MID 2", "Chelsea", "MID"),
  player("recsmoke-spurs-fwd-2", "Spurs FWD 2", "Spurs", "FWD"),
];

// ─── Teams ───────────────────────────────────────────────────────────────────────

export const SCENARIO_LEAGUE = { name: "Recorded Smoke League", inviteCode: "RECSMOKE1" } as const;

export const SCENARIO_USERS = {
  alex: { email: "recsmoke-alex@smoke.local", displayName: "Alex Manager" },
  riley: { email: "recsmoke-riley@smoke.local", displayName: "Riley Rival" },
} as const;

/** Both teams start each with 2 banked free transfers — a plausible mid-season allowance that
 * makes the award arithmetic below visible without hitting the cap of 8. */
export const SEEDED_BANKED_FREE_TRANSFER_COUNT = 2;

export interface ScenarioRosterSlot {
  playerExternalId: string;
  isStarting: boolean;
}

export interface ScenarioTeam {
  name: string;
  rosterSlots: ScenarioRosterSlot[];
  captainExternalId: string;
  viceCaptainExternalId: string;
}

function starting(playerExternalId: string): ScenarioRosterSlot {
  return { playerExternalId, isStarting: true };
}

function bench(playerExternalId: string): ScenarioRosterSlot {
  return { playerExternalId, isStarting: false };
}

/** Alex's team. Captain Liverpool MID 1 never features in M2 (no stat line at all), so the
 * vice-captain (Arsenal MID 1) must receive the 2x bonus. Makes both mid-gameweek transfers. */
export const SCENARIO_TEAM_ALPHA: ScenarioTeam = {
  name: "Alpha XI",
  rosterSlots: [
    starting("recsmoke-chelsea-gk-1"),
    starting("recsmoke-arsenal-def-1"),
    starting("recsmoke-mancity-def-1"),
    starting("recsmoke-spurs-def-1"),
    starting("recsmoke-newcastle-def-1"),
    starting("recsmoke-arsenal-mid-1"),
    starting("recsmoke-liverpool-mid-1"),
    starting("recsmoke-villa-mid-1"),
    starting("recsmoke-brighton-mid-1"),
    starting("recsmoke-mancity-fwd-1"),
    starting("recsmoke-villa-fwd-1"),
    bench("recsmoke-newcastle-gk-1"),
    bench("recsmoke-brighton-def-1"),
    bench("recsmoke-spurs-mid-1"),
    bench("recsmoke-chelsea-fwd-1"),
    bench("recsmoke-liverpool-fwd-1"),
  ],
  captainExternalId: "recsmoke-liverpool-mid-1",
  viceCaptainExternalId: "recsmoke-arsenal-mid-1",
};

/** Riley's team. Captain Arsenal FWD 1 plays and scores in M1, so the normal captain 2x applies.
 * Makes no transfers — the untouched control alongside Alpha's transfer activity. */
export const SCENARIO_TEAM_BRAVO: ScenarioTeam = {
  name: "Bravo XI",
  rosterSlots: [
    starting("recsmoke-arsenal-gk-1"),
    starting("recsmoke-chelsea-def-1"),
    starting("recsmoke-liverpool-def-1"),
    starting("recsmoke-spurs-def-2"),
    starting("recsmoke-villa-def-1"),
    starting("recsmoke-chelsea-mid-1"),
    starting("recsmoke-mancity-mid-1"),
    starting("recsmoke-newcastle-mid-2"),
    starting("recsmoke-villa-mid-2"),
    starting("recsmoke-arsenal-fwd-1"),
    starting("recsmoke-spurs-fwd-1"),
    bench("recsmoke-liverpool-gk-1"),
    bench("recsmoke-brighton-def-2"),
    bench("recsmoke-brighton-mid-2"),
    bench("recsmoke-mancity-fwd-2"),
    bench("recsmoke-newcastle-fwd-1"),
  ],
  captainExternalId: "recsmoke-arsenal-fwd-1",
  viceCaptainExternalId: "recsmoke-chelsea-mid-1",
};

// ─── Per-match player stats (fetched by the importer on each completion transition) ──

export interface ScenarioPlayerMatchStatLine {
  externalPlayerId: string;
  minutesPlayed?: number;
  goalsScored?: number;
  assists?: number;
  savesCount?: number;
  receivedYellowCard?: boolean;
  receivedRedCard?: boolean;
}

/**
 * Stat lines per fixture. Only players who featured get a line — crucially, Liverpool MID 1
 * (Alpha's captain) has NO line in M2: to calculateTeamScores "didn't play" means no PlayerScore
 * row exists, which is what triggers the vice-captain fallback.
 */
export const SCENARIO_STATS_BY_FIXTURE_EXTERNAL_ID: Record<string, ScenarioPlayerMatchStatLine[]> = {
  // Arsenal 2-0 Chelsea (goals: Arsenal DEF 1, Arsenal FWD 1)
  "recsmoke-m1-arsenal-chelsea": [
    { externalPlayerId: "recsmoke-arsenal-def-1", goalsScored: 1 }, // 1 app + 8 goal + 4 CS = 13
    { externalPlayerId: "recsmoke-arsenal-mid-1", assists: 2 }, // 1 + 6 assists = 7
    { externalPlayerId: "recsmoke-arsenal-gk-1", savesCount: 4 }, // 1 + 1 saves + 4 CS = 6
    { externalPlayerId: "recsmoke-arsenal-fwd-1", goalsScored: 1 }, // 1 + 4 goal = 5
    { externalPlayerId: "recsmoke-chelsea-gk-1", savesCount: 2 }, // 1 (conceded 2, saves < 3)
    { externalPlayerId: "recsmoke-chelsea-fwd-1", receivedYellowCard: true }, // 1 - 1 = 0
    { externalPlayerId: "recsmoke-chelsea-def-1" }, // 1
    { externalPlayerId: "recsmoke-chelsea-mid-1" }, // 1
  ],
  // Liverpool 1-1 Man City (goals: Liverpool FWD 1, Man City FWD 1). Liverpool MID 1 absent.
  "recsmoke-m2-liverpool-mancity": [
    { externalPlayerId: "recsmoke-liverpool-fwd-1", goalsScored: 1 }, // 5 — transferred out of Alpha before this, must NOT count for them
    { externalPlayerId: "recsmoke-liverpool-gk-1", savesCount: 3 }, // 2
    { externalPlayerId: "recsmoke-liverpool-def-1" }, // 1
    { externalPlayerId: "recsmoke-mancity-def-1" }, // 1
    { externalPlayerId: "recsmoke-mancity-fwd-1", goalsScored: 1 }, // 5
    { externalPlayerId: "recsmoke-mancity-mid-1", assists: 1 }, // 4
    { externalPlayerId: "recsmoke-mancity-fwd-2" }, // 1
  ],
  // GW2: Aston Villa 2-1 Spurs — none of these points/goals may appear in GW1 totals.
  "recsmoke-m5-villa-spurs": [
    { externalPlayerId: "recsmoke-villa-mid-1", goalsScored: 1 },
    { externalPlayerId: "recsmoke-villa-fwd-1", goalsScored: 1 },
    { externalPlayerId: "recsmoke-spurs-fwd-1", goalsScored: 1 },
  ],
  // Aston Villa 3-1 Brighton (goals: Villa MID 1, Villa FWD 1, Villa DEF 1; Brighton FWD 1)
  "recsmoke-m4-villa-brighton": [
    { externalPlayerId: "recsmoke-villa-mid-1", goalsScored: 1, assists: 1 }, // 1 + 6 + 3 = 10
    { externalPlayerId: "recsmoke-villa-fwd-1", goalsScored: 1 }, // 5
    { externalPlayerId: "recsmoke-villa-def-1", goalsScored: 1 }, // 1 + 8 = 9 (no CS, Brighton scored)
    { externalPlayerId: "recsmoke-villa-mid-2" }, // 1
    { externalPlayerId: "recsmoke-brighton-fwd-1", goalsScored: 1 }, // 5 — transferred INTO Alpha, must count for them
    { externalPlayerId: "recsmoke-brighton-def-1" }, // 1
    { externalPlayerId: "recsmoke-brighton-mid-1" }, // 1
    { externalPlayerId: "recsmoke-brighton-def-2" }, // 1
    { externalPlayerId: "recsmoke-brighton-mid-2" }, // 1
  ],
  // Replayed Wednesday: Spurs 1-0 Newcastle (goal: Spurs MID 1 — by then off Alpha's roster)
  "recsmoke-m3-spurs-newcastle": [
    { externalPlayerId: "recsmoke-spurs-mid-1", goalsScored: 1 }, // 7 — ex-Alpha, must NOT count for them
    { externalPlayerId: "recsmoke-spurs-def-1" }, // 1 + 4 CS = 5
    { externalPlayerId: "recsmoke-spurs-def-2" }, // 5
    { externalPlayerId: "recsmoke-spurs-fwd-1" }, // 1
    { externalPlayerId: "recsmoke-newcastle-gk-1", savesCount: 5 }, // 1 + 1 = 2 (no CS, Spurs scored)
    { externalPlayerId: "recsmoke-newcastle-def-1" }, // 1
    { externalPlayerId: "recsmoke-newcastle-mid-1", assists: 1 }, // 4 — transferred INTO Alpha, must count
    { externalPlayerId: "recsmoke-newcastle-mid-2" }, // 1
    { externalPlayerId: "recsmoke-newcastle-fwd-1", minutesPlayed: 60, receivedRedCard: true }, // 1 - 2 = -1
  ],
};

// ─── Hand-computed expectations (independent of the pipeline — the point of the proof) ──

/**
 * Alpha XI, final GW1 roster (after both transfers):
 *   Arsenal DEF 1 13, Arsenal MID 1 7, Chelsea GK 1 1, Chelsea FWD 1 0, Liverpool MID 1 —,
 *   Man City DEF 1 1, Man City FWD 1 5, Spurs DEF 1 5, Newcastle GK 1 2, Newcastle DEF 1 1,
 *   Villa MID 1 10, Villa FWD 1 5, Brighton DEF 1 1, Brighton MID 1 1,
 *   Brighton FWD 1 (in) 5, Newcastle MID 1 (in) 4 -> base 61.
 *   Captain (Liverpool MID 1) has no score -> vice Arsenal MID 1 bonus +7 -> 68.
 *
 * Bravo XI (untouched roster):
 *   Arsenal GK 1 6, Arsenal FWD 1 5, Chelsea DEF 1 1, Chelsea MID 1 1, Liverpool GK 1 2,
 *   Liverpool DEF 1 1, Man City MID 1 4, Man City FWD 2 1, Spurs DEF 2 5, Spurs FWD 1 1,
 *   Newcastle MID 2 1, Newcastle FWD 1 -1, Villa DEF 1 9, Villa MID 2 1, Brighton DEF 2 1,
 *   Brighton MID 2 1 -> base 39. Captain Arsenal FWD 1 played -> +5 -> 44.
 */
export const EXPECTED_GAMEWEEK_1_TEAM_TOTALS = { alphaXI: 68, bravoXI: 44 } as const;

/** Goals-scored tiebreaker over each team's FINAL roster, GW1 matches only (M5's GW2 goals by
 * Villa MID 1 / Villa FWD 1 / Spurs FWD 1 are excluded): Alpha 5, Bravo 2. */
export const EXPECTED_GAMEWEEK_1_GOALS_TIEBREAKER = { alphaXI: 5, bravoXI: 2 } as const;

/**
 * Banked free transfers, Alpha XI: seeded 2 -> B: free transfer used -> 1 -> D: postponement
 * award is +1 per affected club and Alpha rosters both Spurs and Newcastle players -> +2 -> 3,
 * then the second free transfer -> 2 -> F: gameweek completion award +2 -> 4.
 * Bravo XI: 2 -> D: +2 -> 4 -> F: +2 -> 6.
 */
export const EXPECTED_BANKED_TRANSFERS = {
  alphaAtA: 2,
  alphaAfterTransferAtB: 1,
  alphaAfterPostponementAtD: 3,
  alphaAfterTransferAtD: 2,
  alphaAtF: 4,
  bravoAtF: 6,
} as const;

/**
 * Alpha XI budget: 16-man roster at default prices costs 81 -> 29 remaining. Transfer B swaps
 * Liverpool FWD 1 (5.5) for Brighton FWD 1 (6.5) -> 28. Transfer D swaps Spurs MID 1 (5.5) for
 * Newcastle MID 1 (5.0) -> 28.5. Standings "Spent" is 110 - remaining: Alpha 81.5, Bravo 81.
 */
export const EXPECTED_ALPHA_BUDGET = { atA: 29, afterTransferB: 28, afterTransferD: 28.5 } as const;
