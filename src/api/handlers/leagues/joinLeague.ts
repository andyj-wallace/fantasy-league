import { randomUUID } from "node:crypto";
import { gameweeksRepository, leaguesRepository, teamsRepository } from "../../../db/repositories";
import { GAMEWEEK_JOIN_CUTOFF_NUMBER, MAX_MANAGERS_PER_LEAGUE, STARTING_SQUAD_BUDGET_IN_MILLIONS } from "../../../domain";
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

  const managerCount = await teamsRepository.countByLeagueId(league.id);
  if (managerCount >= MAX_MANAGERS_PER_LEAGUE) return conflictResponse("This league is full.");

  const currentGameweek = await gameweeksRepository.findCurrent();
  if (currentGameweek && currentGameweek.number >= GAMEWEEK_JOIN_CUTOFF_NUMBER) {
    return conflictResponse(`Joining is closed after Gameweek ${GAMEWEEK_JOIN_CUTOFF_NUMBER}.`);
  }

  const team = await teamsRepository.insertOrRevive({
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
