import { playersRepository, teamsRepository } from "../../../db/repositories";
import { deriveStartingFormation, type StartingFormation } from "../../../domain";
import { requireAuth } from "../../auth";
import { badRequestResponse, forbiddenResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface SetTeamLineupRequestBody {
  formation: StartingFormation;
  captainPlayerId: string;
  viceCaptainPlayerId: string;
}

export const setTeamLineup: ApiHandler = requireAuth(async (event, session) => {
  const teamId = event.pathParameters?.teamId ?? "";
  const body = JSON.parse(event.body ?? "{}") as SetTeamLineupRequestBody;
  if (!body.formation || !body.captainPlayerId || !body.viceCaptainPlayerId) {
    return badRequestResponse("formation, captainPlayerId and viceCaptainPlayerId are required");
  }

  const team = await teamsRepository.findById(teamId);
  if (!team) return notFoundResponse();
  if (team.userId !== session.userId) return forbiddenResponse();

  const rosterSlots = await teamsRepository.findRosterSlots(teamId);
  const starters = await playersRepository.findManyByIds(
    rosterSlots.filter((slot) => slot.isStarting).map((slot) => slot.playerId),
  );
  const actualFormation = deriveStartingFormation(starters);
  if (actualFormation !== body.formation) {
    return badRequestResponse(
      actualFormation
        ? `formation must match the current starting XI's shape (${actualFormation})`
        : "The current starting XI does not form a valid formation — fix the roster first",
    );
  }

  await teamsRepository.updateLineup(teamId, {
    formation: body.formation,
    captainPlayerId: body.captainPlayerId,
    viceCaptainPlayerId: body.viceCaptainPlayerId,
  });

  const updatedTeam = await teamsRepository.findFullTeamById(teamId);
  return jsonResponse(200, updatedTeam);
});
