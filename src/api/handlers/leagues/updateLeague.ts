import { leaguesRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { conflictResponse, forbiddenResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
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

  if (body.name !== undefined && existingLeague.areSettingsLocked) {
    return conflictResponse("League settings are locked — unlock them first to rename.");
  }

  const league = await leaguesRepository.update(leagueId, body);
  return jsonResponse(200, league);
});
