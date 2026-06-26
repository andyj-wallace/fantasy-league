import { teamsRepository } from "../../../db/repositories";
import type { StartingFormation } from "../../../domain";
import { badRequestResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface SetTeamLineupRequestBody {
  formation: StartingFormation;
  captainPlayerId: string;
  viceCaptainPlayerId: string;
}

export const setTeamLineup: ApiHandler = async (event) => {
  const teamId = event.pathParameters?.teamId ?? "";
  const body = JSON.parse(event.body ?? "{}") as SetTeamLineupRequestBody;
  if (!body.formation || !body.captainPlayerId || !body.viceCaptainPlayerId) {
    return badRequestResponse("formation, captainPlayerId and viceCaptainPlayerId are required");
  }

  const team = await teamsRepository.findById(teamId);
  if (!team) return notFoundResponse();

  await teamsRepository.updateLineup(teamId, {
    formation: body.formation,
    captainPlayerId: body.captainPlayerId,
    viceCaptainPlayerId: body.viceCaptainPlayerId,
  });

  const updatedTeam = await teamsRepository.findFullTeamById(teamId);
  return jsonResponse(200, updatedTeam);
};
