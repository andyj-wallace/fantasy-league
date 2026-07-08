import type { League } from "@/domain";

/** A user's team as summarised by GET /me/teams — id, name, and remaining budget. */
export interface TeamSummary {
  id: string;
  name: string;
  remainingBudgetInMillions: number;
}

/** One entry from GET /me/teams: a team paired with its league and the two squad-readiness flags
 * the league/home views badge on. Shared so the home list, league page, and TeamLeagueLinks all
 * describe the endpoint the same way instead of each redeclaring it. */
export interface TeamWithLeague {
  team: TeamSummary;
  league: League;
  rosterCount: number;
  isLineupSet: boolean;
}
