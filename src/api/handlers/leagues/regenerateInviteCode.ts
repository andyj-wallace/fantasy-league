import { leaguesRepository } from "../../../db/repositories";
import { generateInviteCode } from "../../inviteCode";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const regenerateInviteCode: ApiHandler = async (event) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const league = await leaguesRepository.update(leagueId, { inviteCode: generateInviteCode() });
  if (!league) return notFoundResponse();
  return jsonResponse(200, league);
};
