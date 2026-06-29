import { teamsRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

/** Powers the logged-in home page's "your leagues" list — every Team the authenticated user
 * holds, each paired with its League. */
export const getMyTeams: ApiHandler = requireAuth(async (_event, session) => {
  const teamsWithLeagues = await teamsRepository.findWithLeagueByUserId(session.userId);
  return jsonResponse(200, teamsWithLeagues);
});
