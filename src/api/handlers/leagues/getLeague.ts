import { leaguesRepository } from "../../../db/repositories";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const getLeague: ApiHandler = async (event) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const league = await leaguesRepository.findById(leagueId);
  if (!league) return notFoundResponse();
  return jsonResponse(200, league);
};
