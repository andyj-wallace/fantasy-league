import { gameweeksRepository, matchesRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

/**
 * Season-awareness context for every screen: the current gameweek (the lowest-numbered one not
 * yet COMPLETED — same definition transfers and lineup changes apply to) plus that gameweek's
 * fixtures with kickoff times and live/final state. Returns { gameweek: null, matches: [] }
 * before the first gameweek has been imported.
 */
export const getCurrentGameweek: ApiHandler = requireAuth(async (_event, _session) => {
  const currentGameweek = await gameweeksRepository.findCurrent();
  if (!currentGameweek) return jsonResponse(200, { gameweek: null, matches: [] });

  const matchesThisGameweek = await matchesRepository.findByGameweekId(currentGameweek.id);
  const matchesSortedByKickoff = [...matchesThisGameweek].sort(
    (firstMatch, secondMatch) => firstMatch.kickoffAt.getTime() - secondMatch.kickoffAt.getTime(),
  );

  return jsonResponse(200, {
    gameweek: {
      id: currentGameweek.id,
      number: currentGameweek.number,
      status: currentGameweek.status,
      deadlineAt: currentGameweek.deadlineAt,
    },
    matches: matchesSortedByKickoff.map((match) => ({
      id: match.id,
      homeClub: match.homeClub,
      awayClub: match.awayClub,
      kickoffAt: match.kickoffAt,
      status: match.status,
      finalHomeScore: match.finalHomeScore,
      finalAwayScore: match.finalAwayScore,
    })),
  });
});
