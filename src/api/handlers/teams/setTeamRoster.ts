import { gameweeksRepository, matchesRepository, playersRepository, teamsRepository } from "../../../db/repositories";
import {
  deriveStartingFormation,
  isClubLocked,
  STARTING_SQUAD_BUDGET_IN_MILLIONS,
  validateSquadComposition,
  type TeamRosterSlot,
} from "../../../domain";
import { requireAuth } from "../../auth";
import { badRequestResponse, forbiddenResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface SetTeamRosterRequestBody {
  rosterSlots: TeamRosterSlot[];
}

export const setTeamRoster: ApiHandler = requireAuth(async (event, session) => {
  const teamId = event.pathParameters?.teamId ?? "";
  const body = JSON.parse(event.body ?? "{}") as SetTeamRosterRequestBody;
  if (!body.rosterSlots) return badRequestResponse("rosterSlots is required");

  const team = await teamsRepository.findById(teamId);
  if (!team) return notFoundResponse();
  if (team.userId !== session.userId) return forbiddenResponse();

  const players = await playersRepository.findManyByIds(body.rosterSlots.map((slot) => slot.playerId));
  if (players.length !== body.rosterSlots.length) return badRequestResponse("One or more playerIds do not exist");

  const squadError = validateSquadComposition(players);
  if (squadError) return badRequestResponse(squadError);

  const playersById = new Map(players.map((player) => [player.id, player]));
  const starters = body.rosterSlots.filter((slot) => slot.isStarting).map((slot) => playersById.get(slot.playerId)!);
  if (!deriveStartingFormation(starters)) {
    return badRequestResponse("Starting XI must be exactly 11 players forming one of the 7 valid formations (1 GK plus a valid DEF-MID-FWD split)");
  }

  const totalSpentInMillions = players.reduce((sum, player) => sum + player.priceInMillions, 0);
  const remainingBudgetInMillions = STARTING_SQUAD_BUDGET_IN_MILLIONS - totalSpentInMillions;

  const currentGameweek = await gameweeksRepository.findCurrent();
  const matchesThisGameweek = currentGameweek ? await matchesRepository.findByGameweekId(currentGameweek.id) : [];

  if (matchesThisGameweek.length > 0) {
    const now = new Date();
    const currentRosterSlots = await teamsRepository.findRosterSlots(teamId);
    const currentSlotByPlayerId = new Map(currentRosterSlots.map((slot) => [slot.playerId, slot]));
    const submittedSlotByPlayerId = new Map(body.rosterSlots.map((slot) => [slot.playerId, slot]));

    const removedPlayerIds = currentRosterSlots
      .filter((slot) => !submittedSlotByPlayerId.has(slot.playerId))
      .map((slot) => slot.playerId);
    if (removedPlayerIds.length > 0) {
      const removedPlayers = await playersRepository.findManyByIds(removedPlayerIds);
      for (const player of removedPlayers) {
        if (isClubLocked(player.club, matchesThisGameweek, now)) {
          return badRequestResponse(`${player.name} is locked — their match has already kicked off`);
        }
      }
    }

    for (const slot of body.rosterSlots) {
      const current = currentSlotByPlayerId.get(slot.playerId);
      if (!current || current.isStarting !== slot.isStarting) {
        const player = playersById.get(slot.playerId)!;
        if (isClubLocked(player.club, matchesThisGameweek, now)) {
          return badRequestResponse(`${player.name} is locked — their match has already kicked off`);
        }
      }
    }
  }

  await teamsRepository.replaceRosterSlots(teamId, body.rosterSlots, remainingBudgetInMillions);

  const updatedTeam = await teamsRepository.findFullTeamById(teamId);
  return jsonResponse(200, updatedTeam);
});
