import { gameweeksRepository, matchesRepository, playersRepository, teamsRepository } from "../../../db/repositories";
import {
  deriveStartingFormation,
  isClubLocked,
  STARTING_SQUAD_BUDGET_IN_MILLIONS,
  validateSquadComposition,
  type TeamRosterSlot,
} from "../../../domain";
import { requireAuth } from "../../auth";
import { badRequestResponse, forbiddenResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface SetTeamRosterRequestBody {
  rosterSlots: TeamRosterSlot[];
}

/**
 * Saves a team's 16-man roster with partial-apply semantics for locked players (decided
 * 2026-07-02): a change touching a locked player is skipped — the locked player keeps their
 * current slot — while every other change in the same save still applies. Each skipped change
 * is reported in the response's lockedChangeWarnings. If the skips leave the effective squad
 * invalid (e.g. 17 players because a locked player couldn't be removed), the save is rejected
 * with the locked adjustments named in the error.
 */
export const setTeamRoster: ApiHandler = requireAuth(async (event, session) => {
  const teamId = event.pathParameters?.teamId ?? "";
  const body = JSON.parse(event.body ?? "{}") as SetTeamRosterRequestBody;
  if (!body.rosterSlots) return badRequestResponse("rosterSlots is required");

  const team = await teamsRepository.findById(teamId);
  if (!team) return notFoundResponse();
  if (team.userId !== session.userId) return forbiddenResponse();

  const submittedPlayers = await playersRepository.findManyByIds(body.rosterSlots.map((slot) => slot.playerId));
  if (submittedPlayers.length !== body.rosterSlots.length) return badRequestResponse("One or more playerIds do not exist");

  const currentGameweek = await gameweeksRepository.findCurrent();
  const matchesThisGameweek = currentGameweek ? await matchesRepository.findByGameweekId(currentGameweek.id) : [];

  const playersById = new Map(submittedPlayers.map((player) => [player.id, player]));
  const effectiveSlots: TeamRosterSlot[] = [];
  const lockedChangeWarnings: string[] = [];

  if (matchesThisGameweek.length > 0) {
    const now = new Date();
    const currentRosterSlots = await teamsRepository.findRosterSlots(teamId);
    const currentSlotByPlayerId = new Map(currentRosterSlots.map((slot) => [slot.playerId, slot]));
    const submittedSlotByPlayerId = new Map(body.rosterSlots.map((slot) => [slot.playerId, slot]));

    for (const slot of body.rosterSlots) {
      const player = playersById.get(slot.playerId)!;
      const currentSlot = currentSlotByPlayerId.get(slot.playerId);
      if (!currentSlot && isClubLocked(player.club, matchesThisGameweek, now)) {
        lockedChangeWarnings.push(`${player.name} is locked — not added to your squad`);
      } else if (currentSlot && currentSlot.isStarting !== slot.isStarting && isClubLocked(player.club, matchesThisGameweek, now)) {
        effectiveSlots.push(currentSlot);
        lockedChangeWarnings.push(
          `${player.name} is locked — kept ${currentSlot.isStarting ? "in the starting XI" : "on the bench"}`,
        );
      } else {
        effectiveSlots.push(slot);
      }
    }

    const removedPlayerIds = currentRosterSlots
      .filter((slot) => !submittedSlotByPlayerId.has(slot.playerId))
      .map((slot) => slot.playerId);
    if (removedPlayerIds.length > 0) {
      const removedPlayers = await playersRepository.findManyByIds(removedPlayerIds);
      for (const removedPlayer of removedPlayers) {
        if (isClubLocked(removedPlayer.club, matchesThisGameweek, now)) {
          effectiveSlots.push(currentSlotByPlayerId.get(removedPlayer.id)!);
          playersById.set(removedPlayer.id, removedPlayer);
          lockedChangeWarnings.push(`${removedPlayer.name} is locked — kept in your squad`);
        }
      }
    }
  } else {
    effectiveSlots.push(...body.rosterSlots);
  }

  const effectivePlayers = effectiveSlots.map((slot) => playersById.get(slot.playerId)!);
  const lockedAdjustmentsSuffix =
    lockedChangeWarnings.length > 0 ? ` (locked-player changes were skipped: ${lockedChangeWarnings.join("; ")})` : "";

  const squadError = validateSquadComposition(effectivePlayers);
  if (squadError) return badRequestResponse(squadError + lockedAdjustmentsSuffix);

  const starters = effectiveSlots.filter((slot) => slot.isStarting).map((slot) => playersById.get(slot.playerId)!);
  if (!deriveStartingFormation(starters)) {
    return badRequestResponse(
      "Starting XI must be exactly 11 players forming one of the 7 valid formations (1 GK plus a valid DEF-MID-FWD split)" +
        lockedAdjustmentsSuffix,
    );
  }

  const totalSpentInMillions = effectivePlayers.reduce((sum, player) => sum + player.priceInMillions, 0);
  const remainingBudgetInMillions = STARTING_SQUAD_BUDGET_IN_MILLIONS - totalSpentInMillions;

  // A roster save can bench or drop whoever currently wears the armband, and nothing else revisits
  // captaincy — so without this the stored captain could outlive their place in the XI and still
  // collect the 2x. Cleared in the same write as the roster, and reported so the manager knows to
  // pick again rather than discovering it when the gameweek scores.
  const effectiveStartingPlayerIds = new Set(
    effectiveSlots.filter((slot) => slot.isStarting).map((slot) => slot.playerId),
  );
  const captaincyToClear = (["captain", "vice-captain"] as const)
    .map((role) => ({
      role,
      playerId: role === "captain" ? team.captainPlayerId : team.viceCaptainPlayerId,
    }))
    .filter(
      (assignment): assignment is { role: "captain" | "vice-captain"; playerId: string } =>
        assignment.playerId !== null && !effectiveStartingPlayerIds.has(assignment.playerId),
    );

  const captaincyChangeWarnings: string[] = [];
  if (captaincyToClear.length > 0) {
    const clearedPlayers = await playersRepository.findManyByIds(captaincyToClear.map((a) => a.playerId));
    const nameByPlayerId = new Map(clearedPlayers.map((player) => [player.id, player.name]));
    for (const { role, playerId } of captaincyToClear) {
      const name = nameByPlayerId.get(playerId);
      captaincyChangeWarnings.push(
        `${name ?? `Your ${role}`} is no longer in your starting XI — ${role} cleared, pick a new one`,
      );
    }
  }

  await teamsRepository.replaceRosterSlots(teamId, effectiveSlots, remainingBudgetInMillions, {
    clearCaptainPlayerId: captaincyToClear.some((a) => a.role === "captain"),
    clearViceCaptainPlayerId: captaincyToClear.some((a) => a.role === "vice-captain"),
  });

  const updatedTeam = await teamsRepository.findFullTeamById(teamId);
  return jsonResponse(200, { ...updatedTeam, lockedChangeWarnings, captaincyChangeWarnings });
});
