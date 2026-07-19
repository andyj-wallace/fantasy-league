import { gameweeksRepository, leaguesRepository, teamsRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { emptyResponse, forbiddenResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";
import { updateStandings } from "../../../workers/updateStandings";

export const removeManager: ApiHandler = requireAuth(async (event, session) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const userId = event.pathParameters?.userId ?? "";

  const league = await leaguesRepository.findById(leagueId);
  if (!league) return notFoundResponse();
  if (league.commissionerUserId !== session.userId) return forbiddenResponse();
  if (userId === league.commissionerUserId) {
    return forbiddenResponse(
      "The commissioner cannot remove themselves — commissionership transfer isn't available yet, so the original commissioner is fixed for the league's duration.",
    );
  }

  const team = await teamsRepository.findByLeagueAndUser(leagueId, userId);
  if (!team) return notFoundResponse("No team found for that manager in this league");

  await teamsRepository.deleteById(team.id);

  const currentGameweek = await gameweeksRepository.findCurrent();
  if (currentGameweek) await updateStandings(leagueId, currentGameweek.id);

  return emptyResponse(204);
});
