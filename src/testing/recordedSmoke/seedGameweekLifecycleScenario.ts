import { randomUUID } from "node:crypto";
import { leaguesRepository, playersRepository, teamsRepository, usersRepository } from "../../db/repositories";
import { STARTING_SQUAD_BUDGET_IN_MILLIONS, type TeamRosterSlot } from "../../domain";
import {
  SCENARIO_LEAGUE,
  SCENARIO_PLAYERS,
  SCENARIO_TEAM_ALPHA,
  SCENARIO_TEAM_BRAVO,
  SCENARIO_USERS,
  SEEDED_BANKED_FREE_TRANSFER_COUNT,
  type ScenarioTeam,
} from "./gameweekLifecycleScenario";

/**
 * Seeds the entities the gameweek-lifecycle scenario starts from: the player pool, two users,
 * their league, and two fully legal 16-man teams with lineups and captains. Deliberately does NOT
 * create any Gameweek or Match rows — those must flow through the real import pipeline when the
 * spec advances to checkpoint A, exactly as production data would.
 *
 * Runs against whatever DATABASE_URL the process was started with; the recorded-smoke
 * orchestrator points that at the throwaway smoke database before importing this module.
 */
export async function seedGameweekLifecycleScenario(): Promise<void> {
  for (const scenarioPlayer of SCENARIO_PLAYERS) {
    await playersRepository.upsertFromRosterImport(scenarioPlayer);
  }

  const playerIdsByExternalId = new Map<string, string>();
  const playerPricesByExternalId = new Map<string, number>();
  for (const scenarioPlayer of SCENARIO_PLAYERS) {
    const row = await playersRepository.findByExternalId(scenarioPlayer.externalId);
    if (!row) throw new Error(`Seed failed to create player ${scenarioPlayer.externalId}`);
    if (scenarioPlayer.priceInMillions !== undefined && row.priceInMillions !== scenarioPlayer.priceInMillions) {
      await playersRepository.updatePrice(row.id, scenarioPlayer.priceInMillions);
    }
    playerIdsByExternalId.set(scenarioPlayer.externalId, row.id);
    playerPricesByExternalId.set(scenarioPlayer.externalId, scenarioPlayer.priceInMillions ?? row.priceInMillions);
  }

  const alex = await usersRepository.insert({
    id: randomUUID(),
    email: SCENARIO_USERS.alex.email,
    displayName: SCENARIO_USERS.alex.displayName,
    cognitoSub: null,
    handle: null,
    createdAt: new Date(),
  });
  const riley = await usersRepository.insert({
    id: randomUUID(),
    email: SCENARIO_USERS.riley.email,
    displayName: SCENARIO_USERS.riley.displayName,
    cognitoSub: null,
    handle: null,
    createdAt: new Date(),
  });

  const league = await leaguesRepository.insert({
    id: randomUUID(),
    name: SCENARIO_LEAGUE.name,
    inviteCode: SCENARIO_LEAGUE.inviteCode,
    commissionerUserId: alex.id,
    areSettingsLocked: false,
    createdAt: new Date(),
  });

  await seedTeam(SCENARIO_TEAM_ALPHA, league.id, alex.id, playerIdsByExternalId, playerPricesByExternalId);
  await seedTeam(SCENARIO_TEAM_BRAVO, league.id, riley.id, playerIdsByExternalId, playerPricesByExternalId);

  console.log(
    `[seedGameweekLifecycleScenario] seeded ${SCENARIO_PLAYERS.length} players, league "${league.name}", teams "${SCENARIO_TEAM_ALPHA.name}" and "${SCENARIO_TEAM_BRAVO.name}"`,
  );
}

async function seedTeam(
  scenarioTeam: ScenarioTeam,
  leagueId: string,
  userId: string,
  playerIdsByExternalId: Map<string, string>,
  playerPricesByExternalId: Map<string, number>,
): Promise<void> {
  const resolvePlayerId = (externalId: string): string => {
    const id = playerIdsByExternalId.get(externalId);
    if (!id) throw new Error(`Scenario team ${scenarioTeam.name} references unknown player ${externalId}`);
    return id;
  };

  const rosterSlots: TeamRosterSlot[] = scenarioTeam.rosterSlots.map((slot) => ({
    playerId: resolvePlayerId(slot.playerExternalId),
    isStarting: slot.isStarting,
  }));
  const totalRosterCostInMillions = scenarioTeam.rosterSlots.reduce(
    (sum, slot) => sum + (playerPricesByExternalId.get(slot.playerExternalId) ?? 0),
    0,
  );

  const team = await teamsRepository.insert({
    id: randomUUID(),
    leagueId,
    userId,
    name: scenarioTeam.name,
    remainingBudgetInMillions: STARTING_SQUAD_BUDGET_IN_MILLIONS - totalRosterCostInMillions,
    bankedFreeTransferCount: SEEDED_BANKED_FREE_TRANSFER_COUNT,
  });
  await teamsRepository.replaceRosterSlots(team.id, rosterSlots, STARTING_SQUAD_BUDGET_IN_MILLIONS - totalRosterCostInMillions);
  await teamsRepository.updateLineup(team.id, {
    formation: "4-4-2",
    captainPlayerId: resolvePlayerId(scenarioTeam.captainExternalId),
    viceCaptainPlayerId: resolvePlayerId(scenarioTeam.viceCaptainExternalId),
  });
}

export interface SeededScenarioEntities {
  leagueId: string;
  alexUserId: string;
  rileyUserId: string;
  alphaTeamId: string;
  bravoTeamId: string;
  playerIdsByExternalId: Map<string, string>;
}

/** Re-resolves the seeded entities by their stable keys (invite code, emails, player external
 * IDs), so the Playwright spec can address them without a handoff file. */
export async function loadSeededScenarioEntities(): Promise<SeededScenarioEntities> {
  const league = await leaguesRepository.findByInviteCode(SCENARIO_LEAGUE.inviteCode);
  const alex = await usersRepository.findByEmail(SCENARIO_USERS.alex.email);
  const riley = await usersRepository.findByEmail(SCENARIO_USERS.riley.email);
  if (!league || !alex || !riley) {
    throw new Error("Recorded-smoke scenario entities not found — did the seed run against this database?");
  }

  const alphaTeam = await teamsRepository.findByLeagueAndUser(league.id, alex.id);
  const bravoTeam = await teamsRepository.findByLeagueAndUser(league.id, riley.id);
  if (!alphaTeam || !bravoTeam) throw new Error("Recorded-smoke scenario teams not found");

  const playerIdsByExternalId = new Map<string, string>();
  for (const scenarioPlayer of SCENARIO_PLAYERS) {
    const row = await playersRepository.findByExternalId(scenarioPlayer.externalId);
    if (row) playerIdsByExternalId.set(scenarioPlayer.externalId, row.id);
  }

  return {
    leagueId: league.id,
    alexUserId: alex.id,
    rileyUserId: riley.id,
    alphaTeamId: alphaTeam.id,
    bravoTeamId: bravoTeam.id,
    playerIdsByExternalId,
  };
}
