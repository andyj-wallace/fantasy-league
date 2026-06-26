import { leaguesRepository } from "../../../db/repositories";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface UpdateLeagueRequestBody {
  name?: string;
  areSettingsLocked?: boolean;
}

export const updateLeague: ApiHandler = async (event) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const body = JSON.parse(event.body ?? "{}") as UpdateLeagueRequestBody;
  const league = await leaguesRepository.update(leagueId, body);
  if (!league) return notFoundResponse();
  return jsonResponse(200, league);
};
