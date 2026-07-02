import { teamsRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const getTeam: ApiHandler = requireAuth(async (event, _session) => {
  const teamId = event.pathParameters?.teamId ?? "";
  const team = await teamsRepository.findFullTeamById(teamId);
  if (!team) return notFoundResponse();
  return jsonResponse(200, team);
});
