import { playersRepository, teamsRepository } from "../../../db/repositories";
import { STARTING_SQUAD_BUDGET_IN_MILLIONS, type TeamRosterSlot } from "../../../domain";
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

  // Real budget calculation; squad-composition rules (budget cap, GK count, club limit,
  // formation legality) aren't enforced yet — that's a dedicated follow-up.
  const players = await playersRepository.findManyByIds(body.rosterSlots.map((slot) => slot.playerId));
  const totalSpentInMillions = players.reduce((sum, player) => sum + player.priceInMillions, 0);
  const remainingBudgetInMillions = STARTING_SQUAD_BUDGET_IN_MILLIONS - totalSpentInMillions;

  await teamsRepository.replaceRosterSlots(teamId, body.rosterSlots, remainingBudgetInMillions);

  const updatedTeam = await teamsRepository.findFullTeamById(teamId);
  return jsonResponse(200, updatedTeam);
});
