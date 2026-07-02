import { leagueStandingsRepository, teamsRepository, usersRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const getLeagueStandings: ApiHandler = requireAuth(async (event, _session) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const gameweekId = event.queryStringParameters?.gameweekId;

  const standings = gameweekId
    ? await leagueStandingsRepository.findForLeagueAndGameweek(leagueId, gameweekId)
    : await leagueStandingsRepository.findLatestForLeague(leagueId);

  const teams = await teamsRepository.findByLeagueId(leagueId);
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const users = await usersRepository.findManyByIds(teams.map((team) => team.userId));
  const managerNamesByUserId = new Map(users.map((user) => [user.id, user.displayName]));

  return jsonResponse(
    200,
    standings.map((standing) => {
      const team = teamsById.get(standing.teamId);
      return {
        ...standing,
        teamName: team?.name ?? standing.teamId,
        managerName: team ? managerNamesByUserId.get(team.userId) ?? team.userId : standing.teamId,
      };
    }),
  );
});
