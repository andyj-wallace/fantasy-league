import type { ApiHandler } from "./types";
import { login } from "./handlers/auth/login";
import { checkEmail } from "./handlers/auth/checkEmail";
import { createLeague } from "./handlers/leagues/createLeague";
import { joinLeague } from "./handlers/leagues/joinLeague";
import { getLeague } from "./handlers/leagues/getLeague";
import { updateLeague } from "./handlers/leagues/updateLeague";
import { regenerateInviteCode } from "./handlers/leagues/regenerateInviteCode";
import { removeManager } from "./handlers/leagues/removeManager";
import { getMyTeams } from "./handlers/teams/getMyTeams";
import { getTeam } from "./handlers/teams/getTeam";
import { setTeamRoster } from "./handlers/teams/setTeamRoster";
import { setTeamLineup } from "./handlers/teams/setTeamLineup";
import { searchPlayers } from "./handlers/players/searchPlayers";
import { getPlayer } from "./handlers/players/getPlayer";
import { getAvailableTransfers } from "./handlers/transfers/getAvailableTransfers";
import { makeTransfer } from "./handlers/transfers/makeTransfer";
import { getLeagueStandings } from "./handlers/leaderboard/getLeagueStandings";

/**
 * One entry per Lambda. In API Gateway this same {method, path} pairing becomes the resource's
 * proxy integration; here it doubles as the route table for the local dev server.
 */
export interface RouteDefinition {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  handler: ApiHandler;
}

export const routes: RouteDefinition[] = [
  { method: "POST", path: "/auth/login", handler: login },
  { method: "POST", path: "/auth/check-email", handler: checkEmail },
  { method: "POST", path: "/leagues", handler: createLeague },
  { method: "POST", path: "/leagues/join", handler: joinLeague },
  { method: "GET", path: "/leagues/:leagueId", handler: getLeague },
  { method: "PATCH", path: "/leagues/:leagueId", handler: updateLeague },
  { method: "POST", path: "/leagues/:leagueId/invite-code/regenerate", handler: regenerateInviteCode },
  { method: "DELETE", path: "/leagues/:leagueId/managers/:userId", handler: removeManager },
  { method: "GET", path: "/me/teams", handler: getMyTeams },
  { method: "GET", path: "/teams/:teamId", handler: getTeam },
  { method: "PUT", path: "/teams/:teamId/roster", handler: setTeamRoster },
  { method: "PUT", path: "/teams/:teamId/lineup", handler: setTeamLineup },
  { method: "GET", path: "/players", handler: searchPlayers },
  { method: "GET", path: "/players/:playerId", handler: getPlayer },
  { method: "GET", path: "/teams/:teamId/transfers/available", handler: getAvailableTransfers },
  { method: "POST", path: "/teams/:teamId/transfers", handler: makeTransfer },
  { method: "GET", path: "/leagues/:leagueId/standings", handler: getLeagueStandings },
];
