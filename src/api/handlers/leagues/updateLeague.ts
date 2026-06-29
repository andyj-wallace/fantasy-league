import { leaguesRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { forbiddenResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface UpdateLeagueRequestBody {
  name?: string;
  areSettingsLocked?: boolean;
}

export const updateLeague: ApiHandler = requireAuth(async (event, session) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const body = JSON.parse(event.body ?? "{}") as UpdateLeagueRequestBody;

  const existingLeague = await leaguesRepository.findById(leagueId);
  if (!existingLeague) return notFoundResponse();
  if (existingLeague.commissionerUserId !== session.userId) return forbiddenResponse();

  const league = await leaguesRepository.update(leagueId, body);
  return jsonResponse(200, league);
});
