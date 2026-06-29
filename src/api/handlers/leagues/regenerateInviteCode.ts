import { leaguesRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { generateInviteCode } from "../../inviteCode";
import { forbiddenResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const regenerateInviteCode: ApiHandler = requireAuth(async (event, session) => {
  const leagueId = event.pathParameters?.leagueId ?? "";

  const existingLeague = await leaguesRepository.findById(leagueId);
  if (!existingLeague) return notFoundResponse();
  if (existingLeague.commissionerUserId !== session.userId) return forbiddenResponse();

  const league = await leaguesRepository.update(leagueId, { inviteCode: generateInviteCode() });
  return jsonResponse(200, league);
});
