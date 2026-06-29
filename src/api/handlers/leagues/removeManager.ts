import { leaguesRepository, teamsRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { emptyResponse, forbiddenResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const removeManager: ApiHandler = requireAuth(async (event, session) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const userId = event.pathParameters?.userId ?? "";

  const league = await leaguesRepository.findById(leagueId);
  if (!league) return notFoundResponse();
  if (league.commissionerUserId !== session.userId) return forbiddenResponse();

  const team = await teamsRepository.findByLeagueAndUser(leagueId, userId);
  if (!team) return notFoundResponse("No team found for that manager in this league");

  await teamsRepository.deleteById(team.id);
  return emptyResponse(204);
});
