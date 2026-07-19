import { leaguesRepository, teamsRepository, usersRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export interface LeagueMember {
  userId: string;
  displayName: string;
  teamId: string;
  teamName: string;
  isCommissioner: boolean;
}

/** Backs the League Settings Members section — unlike getLeagueStandings, this has no dependency
 * on any gameweek having completed scoring, so it works for a league that hasn't kicked off yet. */
export const getLeagueMembers: ApiHandler = requireAuth(async (event, _session) => {
  const leagueId = event.pathParameters?.leagueId ?? "";

  const league = await leaguesRepository.findById(leagueId);
  if (!league) return notFoundResponse();

  const teams = await teamsRepository.findByLeagueId(leagueId);
  const users = await usersRepository.findManyByIds(teams.map((team) => team.userId));
  const usersById = new Map(users.map((user) => [user.id, user]));

  const members: LeagueMember[] = teams.map((team) => ({
    userId: team.userId,
    displayName: usersById.get(team.userId)?.displayName ?? team.userId,
    teamId: team.id,
    teamName: team.name,
    isCommissioner: team.userId === league.commissionerUserId,
  }));

  return jsonResponse(200, { members });
});
