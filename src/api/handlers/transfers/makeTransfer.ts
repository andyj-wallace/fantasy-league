import { randomUUID } from "node:crypto";
import { db } from "../../../db/client";
import { gameweeksRepository, matchesRepository, playersRepository, teamsRepository, transfersRepository } from "../../../db/repositories";
import { deriveStartingFormation, isClubLocked, POINTS_COST_PER_PAID_TRANSFER, validateSquadComposition, type Transfer } from "../../../domain";
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

  const matchesThisGameweek = await matchesRepository.findByGameweekId(currentGameweek.id);
  const now = new Date();
  if (isClubLocked(playerOut.club, matchesThisGameweek, now)) {
    return badRequestResponse(`${playerOut.name} is locked — their match has already kicked off`);
  }
  if (isClubLocked(playerIn.club, matchesThisGameweek, now)) {
    return badRequestResponse(`${playerIn.name} is locked — their match has already kicked off`);
  }

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

  // Wrap all writes in a transaction and re-read the team with FOR UPDATE so concurrent transfer
  // requests for the same team block here rather than racing on budget / bankedFreeTransferCount.
  return await db.transaction(async (tx) => {
    const lockedTeam = await teamsRepository.findByIdForUpdate(teamId, tx);
    if (!lockedTeam) return notFoundResponse("Team not found");

    const pointsCost = lockedTeam.bankedFreeTransferCount > 0 ? 0 : POINTS_COST_PER_PAID_TRANSFER;
    const remainingBudgetInMillions =
      lockedTeam.remainingBudgetInMillions + playerOut.priceInMillions - playerIn.priceInMillions;
    const bankedFreeTransferCount =
      pointsCost === 0 ? lockedTeam.bankedFreeTransferCount - 1 : lockedTeam.bankedFreeTransferCount;

    if (remainingBudgetInMillions < 0) return badRequestResponse("Insufficient budget for this transfer");

    await teamsRepository.replaceRosterSlots(teamId, updatedRosterSlots, remainingBudgetInMillions, {
      tx,
      clearCaptainPlayerId: lockedTeam.captainPlayerId === body.playerOutId,
      clearViceCaptainPlayerId: lockedTeam.viceCaptainPlayerId === body.playerOutId,
    });
    await teamsRepository.updateAfterTransfer(teamId, { remainingBudgetInMillions, bankedFreeTransferCount }, tx);

    const transfer: Transfer = {
      id: randomUUID(),
      teamId,
      gameweekId: currentGameweek.id,
      playerOutId: body.playerOutId,
      playerInId: body.playerInId,
      pointsCost,
      createdAt: new Date(),
    };
    await transfersRepository.insert(transfer, tx);

    // Nothing follows a transfer the way a lineup save follows a roster save, so if this transfer
    // took the armband out of the squad the manager has to be told here or not at all.
    const clearedCaptaincyRoles = (["captain", "vice-captain"] as const).filter((role) =>
      role === "captain"
        ? lockedTeam.captainPlayerId === body.playerOutId
        : lockedTeam.viceCaptainPlayerId === body.playerOutId,
    );
    const captaincyChangeWarnings = clearedCaptaincyRoles.map(
      (role) => `${playerOut.name} was your ${role} — ${role} cleared, pick a new one before the deadline`,
    );

    return jsonResponse(201, { ...transfer, captaincyChangeWarnings });
  });
});
