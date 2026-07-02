import { randomUUID } from "node:crypto";
import { leaguesRepository, teamsRepository } from "../../../db/repositories";
import { STARTING_SQUAD_BUDGET_IN_MILLIONS } from "../../../domain";
import { requireAuth } from "../../auth";
import { badRequestResponse, conflictResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface JoinLeagueRequestBody {
  inviteCode: string;
  teamName?: string;
}

export const joinLeague: ApiHandler = requireAuth(async (event, session) => {
  const body = JSON.parse(event.body ?? "{}") as JoinLeagueRequestBody;
  if (!body.inviteCode) return badRequestResponse("inviteCode is required");

  const league = await leaguesRepository.findByInviteCode(body.inviteCode);
  if (!league) return notFoundResponse("No league found for that invite code");

  const team = await teamsRepository.insertIfAbsent({
    id: randomUUID(),
    leagueId: league.id,
    userId: session.userId,
    name: body.teamName ?? "New Team",
    remainingBudgetInMillions: STARTING_SQUAD_BUDGET_IN_MILLIONS,
    bankedFreeTransferCount: 0,
  });
  if (!team) return conflictResponse("You've already joined this league");

  return jsonResponse(201, { league, team });
});
