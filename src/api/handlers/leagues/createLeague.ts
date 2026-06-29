import { randomUUID } from "node:crypto";
import { leaguesRepository, teamsRepository } from "../../../db/repositories";
import { STARTING_SQUAD_BUDGET_IN_MILLIONS } from "../../../domain";
import { requireAuth } from "../../auth";
import { generateInviteCode } from "../../inviteCode";
import { badRequestResponse, jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface CreateLeagueRequestBody {
  name: string;
  teamName?: string;
}

/** Creates the league and the commissioner's own Team in one call — a league with no team for
 * its creator was an awkward extra step (you'd otherwise have to immediately call /leagues/join
 * with your own invite code just to get a team). */
export const createLeague: ApiHandler = requireAuth(async (event, session) => {
  const body = JSON.parse(event.body ?? "{}") as CreateLeagueRequestBody;
  if (!body.name) return badRequestResponse("name is required");

  const league = await leaguesRepository.insert({
    id: randomUUID(),
    name: body.name,
    inviteCode: generateInviteCode(),
    commissionerUserId: session.userId,
    areSettingsLocked: false,
    createdAt: new Date(),
  });

  const team = await teamsRepository.insert({
    id: randomUUID(),
    leagueId: league.id,
    userId: session.userId,
    name: body.teamName ?? "New Team",
    remainingBudgetInMillions: STARTING_SQUAD_BUDGET_IN_MILLIONS,
    bankedFreeTransferCount: 0,
  });

  return jsonResponse(201, { league, team });
});
