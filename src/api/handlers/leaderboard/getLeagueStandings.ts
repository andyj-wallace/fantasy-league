import {
  gameweeksRepository,
  leagueStandingsRepository,
  teamsRepository,
  usersRepository,
} from "../../../db/repositories";
import {
  roundToNearestTenthOfMillion,
  STARTING_SQUAD_BUDGET_IN_MILLIONS,
  rankTeamStandings,
  type LeagueStanding,
} from "../../../domain";
import { requireAuth } from "../../auth";
import { jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

/** Just the team fields a baseline row is built from — the roster isn't read on this path. */
interface TeamBaselineInput {
  id: string;
  remainingBudgetInMillions: number;
  bankedFreeTransferCount: number;
}

/**
 * The league table a manager sees before a single match in the league has been scored: every team
 * on zero points, ordered by the tiebreakers that already have values (banked transfers, then least
 * spent), so a new league opens on a real table instead of a paragraph explaining why there isn't
 * one. Everyone level on all of them shares rank 1, which is the honest starting position.
 *
 * This is not the compute-on-read the architecture doc rules out — no team's score is calculated
 * here. It is a zero-fill of teams this handler already had to load to resolve names, and it is
 * only reached when the precomputed table genuinely has no rows yet. As soon as updateStandings has
 * written a real one, that is what gets returned.
 */
function buildUnscoredBaselineStandings(leagueId: string, teams: TeamBaselineInput[]): LeagueStanding[] {
  const rankable = teams.map((team) => ({
    teamId: team.id,
    totalPoints: 0,
    tiebreakerStats: {
      goalsScoredBySelectedPlayers: 0,
      bankedFreeTransferCount: team.bankedFreeTransferCount,
      totalSpentInMillions: roundToNearestTenthOfMillion(
        STARTING_SQUAD_BUDGET_IN_MILLIONS - team.remainingBudgetInMillions,
      ),
    },
  }));

  const calculatedAt = new Date();
  return rankTeamStandings(rankable).map((row) => ({
    // Synthetic and never persisted — the frontend only needs a stable list key, and there is no
    // stored row to carry an id. Scoped to the team so it stays stable across refetches.
    id: `baseline:${row.teamId}`,
    leagueId,
    gameweekId: "",
    teamId: row.teamId,
    rank: row.rank,
    totalPoints: row.totalPoints,
    tiebreakerStats: row.tiebreakerStats,
    calculatedAt,
  }));
}

export const getLeagueStandings: ApiHandler = requireAuth(async (event, _session) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const gameweekId = event.queryStringParameters?.gameweekId;

  const precomputedStandings = gameweekId
    ? await leagueStandingsRepository.findForLeagueAndGameweek(leagueId, gameweekId)
    : await leagueStandingsRepository.findLatestForLeague(leagueId);

  const teams = await teamsRepository.findByLeagueId(leagueId);
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const users = await usersRepository.findManyByIds(teams.map((team) => team.userId));
  const managerNamesByUserId = new Map(users.map((user) => [user.id, user.displayName]));

  const isAwaitingFirstScoredGameweek = precomputedStandings.length === 0;
  const standings = isAwaitingFirstScoredGameweek
    ? buildUnscoredBaselineStandings(leagueId, teams)
    : precomputedStandings;

  const standingsGameweek =
    precomputedStandings.length > 0 ? await gameweeksRepository.findById(precomputedStandings[0]!.gameweekId) : null;

  return jsonResponse(200, {
    gameweek: standingsGameweek
      ? { number: standingsGameweek.number, status: standingsGameweek.status }
      : null,
    // Lets the frontend say "nobody has scored yet" over a real table, rather than having to infer
    // it from every row being on zero — which a genuinely goalless scored gameweek also looks like.
    isAwaitingFirstScoredGameweek,
    standings: standings.map((standing) => {
      const team = teamsById.get(standing.teamId);
      return {
        ...standing,
        teamName: team?.name ?? standing.teamId,
        managerName: team ? managerNamesByUserId.get(team.userId) ?? team.userId : standing.teamId,
      };
    }),
  });
});
