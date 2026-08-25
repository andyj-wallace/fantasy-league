import { gameweeksRepository, teamsRepository, transfersRepository } from "../../../db/repositories";
import { requireAuth } from "../../auth";
import { forbiddenResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

/**
 * The squad builder's view of one Team: the full roster, formation and captaincy, plus what the
 * transfers already made this gameweek will cost when calculateTeamScores charges them.
 *
 * The cost is reported as a positive magnitude (matching Transfer.pointsCost and
 * TeamScore.transferPointsCost) together with how many transfers were charged for, so the screen
 * can show the pending deduction while the gameweek is still being edited — the alternative is a
 * manager first meeting the charge as an unexplained gap in the standings.
 */
export const getTeam: ApiHandler = requireAuth(async (event, session) => {
  const teamId = event.pathParameters?.teamId ?? "";
  const team = await teamsRepository.findFullTeamById(teamId);
  if (!team) return notFoundResponse();
  if (team.userId !== session.userId) return forbiddenResponse();

  const currentGameweek = await gameweeksRepository.findCurrent();
  const transfersThisGameweek = currentGameweek
    ? await transfersRepository.findByTeamAndGameweek(teamId, currentGameweek.id)
    : [];
  const paidTransfersThisGameweek = transfersThisGameweek.filter((transfer) => transfer.pointsCost > 0);

  return jsonResponse(200, {
    ...team,
    transferPointsCostThisGameweek: paidTransfersThisGameweek.reduce(
      (runningPointsCost, transfer) => runningPointsCost + transfer.pointsCost,
      0,
    ),
    paidTransferCountThisGameweek: paidTransfersThisGameweek.length,
  });
});
