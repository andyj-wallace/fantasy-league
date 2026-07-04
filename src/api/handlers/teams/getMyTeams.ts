import { teamsRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

/** Powers the logged-in home page's "your leagues" list — every Team the authenticated user
 * holds, each paired with its League, plus enough squad-completeness state (rosterCount,
 * isLineupSet) for the list to flag teams that still need setting up. The per-team roster
 * lookup is a loop, which is fine at this scale: a user is in a handful of leagues at most. */
export const getMyTeams: ApiHandler = requireAuth(async (_event, session) => {
  const teamsWithLeagues = await teamsRepository.findWithLeagueByUserId(session.userId);
  const teamsWithLeaguesAndSquadState = await Promise.all(
    teamsWithLeagues.map(async ({ team, league }) => {
      const rosterSlots = await teamsRepository.findRosterSlots(team.id);
      return {
        team,
        league,
        rosterCount: rosterSlots.length,
        isLineupSet:
          team.formation !== null && team.captainPlayerId !== null && team.viceCaptainPlayerId !== null,
      };
    }),
  );
  return jsonResponse(200, teamsWithLeaguesAndSquadState);
});
