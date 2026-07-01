import { gameweeksRepository, matchesRepository, playersRepository, teamsRepository } from "../../../db/repositories";
import { deriveStartingFormation, isClubLocked, type StartingFormation } from "../../../domain";
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
  const allRosterPlayers = await playersRepository.findManyByIds(rosterSlots.map((slot) => slot.playerId));
  const allRosterPlayersById = new Map(allRosterPlayers.map((player) => [player.id, player]));
  const starters = rosterSlots
    .filter((slot) => slot.isStarting)
    .map((slot) => allRosterPlayersById.get(slot.playerId)!)
    .filter(Boolean);
  const actualFormation = deriveStartingFormation(starters);
  if (actualFormation !== body.formation) {
    return badRequestResponse(
      actualFormation
        ? `formation must match the current starting XI's shape (${actualFormation})`
        : "The current starting XI does not form a valid formation — fix the roster first",
    );
  }

  const currentGameweek = await gameweeksRepository.findCurrent();
  const matchesThisGameweek = currentGameweek ? await matchesRepository.findByGameweekId(currentGameweek.id) : [];

  if (matchesThisGameweek.length > 0) {
    const now = new Date();

    if (body.captainPlayerId !== team.captainPlayerId) {
      const newCaptain = allRosterPlayersById.get(body.captainPlayerId);
      if (newCaptain && isClubLocked(newCaptain.club, matchesThisGameweek, now)) {
        return badRequestResponse(`${newCaptain.name} is locked — their match has already kicked off`);
      }
    }

    if (body.viceCaptainPlayerId !== team.viceCaptainPlayerId) {
      const newViceCaptain = allRosterPlayersById.get(body.viceCaptainPlayerId);
      if (newViceCaptain && isClubLocked(newViceCaptain.club, matchesThisGameweek, now)) {
        return badRequestResponse(`${newViceCaptain.name} is locked — their match has already kicked off`);
      }
    }
  }

  await teamsRepository.updateLineup(teamId, {
    formation: body.formation,
    captainPlayerId: body.captainPlayerId,
    viceCaptainPlayerId: body.viceCaptainPlayerId,
  });

  const updatedTeam = await teamsRepository.findFullTeamById(teamId);
  return jsonResponse(200, updatedTeam);
});
