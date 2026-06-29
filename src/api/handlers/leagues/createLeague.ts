import { randomUUID } from "node:crypto";
import { leaguesRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { generateInviteCode } from "../../inviteCode";
import { badRequestResponse, jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface CreateLeagueRequestBody {
  name: string;
}

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

  return jsonResponse(201, league);
});
