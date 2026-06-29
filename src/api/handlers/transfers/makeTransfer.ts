import { randomUUID } from "node:crypto";
import { gameweeksRepository, playersRepository, teamsRepository, transfersRepository } from "../../../db/repositories";
import { deriveStartingFormation, validateSquadComposition, type Transfer } from "../../../domain";
import { requireAuth } from "../../auth";
import { badRequestResponse, forbiddenResponse, jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface MakeTransferRequestBody {
  playerOutId: string;
  playerInId: string;
}

export const makeTransfer: ApiHandler = requireAuth(async (event, session) => {
  const teamId = event.pathParameters?.teamId ?? "";
  const body = JSON.parse(event.body ?? "{}") as MakeTransferRequestBody;
  if (!body.playerOutId || !body.playerInId) {
    return badRequestResponse("playerOutId and playerInId are required");
  }

  const team = await teamsRepository.findById(teamId);
  if (!team) return notFoundResponse("Team not found");
  if (team.userId !== session.userId) return forbiddenResponse();

  const currentGameweek = await gameweeksRepository.findCurrent();
  if (!currentGameweek) return badRequestResponse("No active gameweek to record this transfer against");

  const rosterSlots = await teamsRepository.findRosterSlots(teamId);
  const outgoingSlot = rosterSlots.find((slot) => slot.playerId === body.playerOutId);
  if (!outgoingSlot) return badRequestResponse("playerOutId is not on this team's roster");

  const [playerOut, playerIn] = await Promise.all([
    playersRepository.findById(body.playerOutId),
    playersRepository.findById(body.playerInId),
  ]);
  if (!playerOut || !playerIn) return notFoundResponse("playerOutId or playerInId does not exist");

  const updatedRosterSlots = rosterSlots.map((slot) =>
    slot.playerId === body.playerOutId ? { playerId: body.playerInId, isStarting: slot.isStarting } : slot,
  );

  const updatedPlayers = await playersRepository.findManyByIds(updatedRosterSlots.map((slot) => slot.playerId));
  const squadError = validateSquadComposition(updatedPlayers);
  if (squadError) return badRequestResponse(squadError);

  const updatedPlayersById = new Map(updatedPlayers.map((player) => [player.id, player]));
  const starters = updatedRosterSlots
    .filter((slot) => slot.isStarting)
    .map((slot) => updatedPlayersById.get(slot.playerId)!);
  if (!deriveStartingFormation(starters)) {
    return badRequestResponse("This transfer would leave the starting XI without a valid formation");
  }

  // Real cost/budget calculation, now squad-composition-checked above.
  const pointsCost = team.bankedFreeTransferCount > 0 ? 0 : 10;
  const remainingBudgetInMillions = team.remainingBudgetInMillions + playerOut.priceInMillions - playerIn.priceInMillions;
  const bankedFreeTransferCount = pointsCost === 0 ? team.bankedFreeTransferCount - 1 : team.bankedFreeTransferCount;

  await teamsRepository.replaceRosterSlots(teamId, updatedRosterSlots, remainingBudgetInMillions);
  await teamsRepository.updateAfterTransfer(teamId, { remainingBudgetInMillions, bankedFreeTransferCount });

  const transfer: Transfer = {
    id: randomUUID(),
    teamId,
    gameweekId: currentGameweek.id,
    playerOutId: body.playerOutId,
    playerInId: body.playerInId,
    pointsCost,
    createdAt: new Date(),
  };
  await transfersRepository.insert(transfer);

  return jsonResponse(201, transfer);
});
