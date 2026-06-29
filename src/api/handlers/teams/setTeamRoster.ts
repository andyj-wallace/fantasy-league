import { playersRepository, teamsRepository } from "../../../db/repositories";
import {
  deriveStartingFormation,
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

  await teamsRepository.replaceRosterSlots(teamId, body.rosterSlots, remainingBudgetInMillions);

  const updatedTeam = await teamsRepository.findFullTeamById(teamId);
  return jsonResponse(200, updatedTeam);
});
