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

/**
 * Saves a team's formation and captaincy with partial-apply semantics for locked players
 * (decided 2026-07-02): a captain/vice-captain change onto a locked player is skipped — the
 * current assignment is kept — while the rest of the save still applies. Each skipped change is
 * reported in the response's lockedChangeWarnings. If the skips would leave the captain and
 * vice-captain as the same player (e.g. a captain/vice swap where one side is locked), the save
 * is rejected instead.
 */
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

  let effectiveCaptainPlayerId = body.captainPlayerId;
  let effectiveViceCaptainPlayerId = body.viceCaptainPlayerId;
  const lockedChangeWarnings: string[] = [];

  if (matchesThisGameweek.length > 0) {
    const now = new Date();

    if (body.captainPlayerId !== team.captainPlayerId) {
      const newCaptain = allRosterPlayersById.get(body.captainPlayerId);
      if (newCaptain && isClubLocked(newCaptain.club, matchesThisGameweek, now)) {
        if (!team.captainPlayerId) {
          return badRequestResponse(`${newCaptain.name} is locked and there is no current captain to keep — choose an unlocked captain`);
        }
        effectiveCaptainPlayerId = team.captainPlayerId;
        lockedChangeWarnings.push(`${newCaptain.name} is locked — captain unchanged`);
      }
    }

    if (body.viceCaptainPlayerId !== team.viceCaptainPlayerId) {
      const newViceCaptain = allRosterPlayersById.get(body.viceCaptainPlayerId);
      if (newViceCaptain && isClubLocked(newViceCaptain.club, matchesThisGameweek, now)) {
        if (!team.viceCaptainPlayerId) {
          return badRequestResponse(
            `${newViceCaptain.name} is locked and there is no current vice-captain to keep — choose an unlocked vice-captain`,
          );
        }
        effectiveViceCaptainPlayerId = team.viceCaptainPlayerId;
        lockedChangeWarnings.push(`${newViceCaptain.name} is locked — vice-captain unchanged`);
      }
    }
  }

  if (effectiveCaptainPlayerId === effectiveViceCaptainPlayerId) {
    const collisionExplanation =
      lockedChangeWarnings.length > 0
        ? ` after skipping locked-player changes (${lockedChangeWarnings.join("; ")})`
        : "";
    return badRequestResponse(`captain and vice-captain must be different players${collisionExplanation}`);
  }

  await teamsRepository.updateLineup(teamId, {
    formation: body.formation,
    captainPlayerId: effectiveCaptainPlayerId,
    viceCaptainPlayerId: effectiveViceCaptainPlayerId,
  });

  const updatedTeam = await teamsRepository.findFullTeamById(teamId);
  return jsonResponse(200, { ...updatedTeam, lockedChangeWarnings });
});
