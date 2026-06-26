import { randomUUID } from "node:crypto";
import { leaguesRepository, teamsRepository } from "../../../db/repositories";
import { STARTING_SQUAD_BUDGET_IN_MILLIONS } from "../../../domain";
import { badRequestResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface JoinLeagueRequestBody {
  inviteCode: string;
  userId: string;
  teamName?: string;
}

export const joinLeague: ApiHandler = async (event) => {
  const body = JSON.parse(event.body ?? "{}") as JoinLeagueRequestBody;
  if (!body.inviteCode || !body.userId) {
    return badRequestResponse("inviteCode and userId are required");
  }

  const league = await leaguesRepository.findByInviteCode(body.inviteCode);
  if (!league) return notFoundResponse("No league found for that invite code");

  const team = await teamsRepository.insert({
    id: randomUUID(),
    leagueId: league.id,
    userId: body.userId,
    name: body.teamName ?? "New Team",
    remainingBudgetInMillions: STARTING_SQUAD_BUDGET_IN_MILLIONS,
    bankedFreeTransferCount: 0,
  });

  return jsonResponse(201, { league, team });
};
