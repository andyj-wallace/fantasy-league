import { leaguesRepository, teamsRepository } from "../../../db/repositories";
import { IS_COMMISSIONERSHIP_TRANSFER_ENABLED } from "../../../domain";
import { requireAuth } from "../../auth";
import { badRequestResponse, forbiddenResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface TransferCommissionershipRequestBody {
  newCommissionerUserId?: string;
}

export const transferCommissionership: ApiHandler = requireAuth(async (event, session) => {
  if (!IS_COMMISSIONERSHIP_TRANSFER_ENABLED) {
    return forbiddenResponse("Commissionership transfer is not available yet — the commissioner is fixed for the league's duration.");
  }

  const leagueId = event.pathParameters?.leagueId ?? "";
  const body = JSON.parse(event.body ?? "{}") as TransferCommissionershipRequestBody;

  const league = await leaguesRepository.findById(leagueId);
  if (!league) return notFoundResponse();
  if (league.commissionerUserId !== session.userId) return forbiddenResponse();
  if (!body.newCommissionerUserId) return badRequestResponse("newCommissionerUserId is required");

  const targetTeam = await teamsRepository.findByLeagueAndUser(leagueId, body.newCommissionerUserId);
  if (!targetTeam) return badRequestResponse("Target must be a member of this league");

  const updatedLeague = await leaguesRepository.transferCommissionership(leagueId, body.newCommissionerUserId);
  return jsonResponse(200, updatedLeague);
});
