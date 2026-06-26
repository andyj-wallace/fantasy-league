import { teamsRepository } from "../../../db/repositories";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const getTeam: ApiHandler = async (event) => {
  const teamId = event.pathParameters?.teamId ?? "";
  const team = await teamsRepository.findFullTeamById(teamId);
  if (!team) return notFoundResponse();
  return jsonResponse(200, team);
};
