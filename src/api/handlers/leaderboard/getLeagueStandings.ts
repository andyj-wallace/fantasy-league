import { leagueStandingsRepository } from "../../../db/repositories";
import { jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const getLeagueStandings: ApiHandler = async (event) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const gameweekId = event.queryStringParameters?.gameweekId;

  const standings = gameweekId
    ? await leagueStandingsRepository.findForLeagueAndGameweek(leagueId, gameweekId)
    : await leagueStandingsRepository.findLatestForLeague(leagueId);

  return jsonResponse(200, standings);
};
