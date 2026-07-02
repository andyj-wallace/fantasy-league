import { leaguesRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const getLeague: ApiHandler = requireAuth(async (event, _session) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const league = await leaguesRepository.findById(leagueId);
  if (!league) return notFoundResponse();
  return jsonResponse(200, league);
});
