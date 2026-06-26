import { randomUUID } from "node:crypto";
import { leaguesRepository } from "../../../db/repositories";
import { generateInviteCode } from "../../inviteCode";
import { badRequestResponse, jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface CreateLeagueRequestBody {
  name: string;
  commissionerUserId: string;
}

export const createLeague: ApiHandler = async (event) => {
  const body = JSON.parse(event.body ?? "{}") as CreateLeagueRequestBody;
  if (!body.name || !body.commissionerUserId) {
    return badRequestResponse("name and commissionerUserId are required");
  }

  const league = await leaguesRepository.insert({
    id: randomUUID(),
    name: body.name,
    inviteCode: generateInviteCode(),
    commissionerUserId: body.commissionerUserId,
    areSettingsLocked: false,
    createdAt: new Date(),
  });

  return jsonResponse(201, league);
};
