import { teamsRepository } from "../../../db/repositories";
import { emptyResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const removeManager: ApiHandler = async (event) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const userId = event.pathParameters?.userId ?? "";

  const team = await teamsRepository.findByLeagueAndUser(leagueId, userId);
  if (!team) return notFoundResponse("No team found for that manager in this league");

  await teamsRepository.deleteById(team.id);
  return emptyResponse(204);
};
