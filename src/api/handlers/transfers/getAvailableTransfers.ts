import {
  gameweeksRepository,
  matchesRepository,
  playersRepository,
  teamsRepository,
  transfersRepository,
} from "../../../db/repositories";
import { isClubLocked, MAX_BANKED_FREE_TRANSFER_COUNT, POINTS_COST_PER_PAID_TRANSFER } from "../../../domain";
import { requireAuth } from "../../auth";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";
import { attachPlayerStats } from "../players/attachPlayerStats";

/**
 * Everything the Transfers screen displays: banked free transfers (and what the next transfer
 * would cost), remaining budget, the roster with each player's lock status for the current
 * gameweek, and the transfers already made this gameweek. Display-only for now — making a
 * transfer is still POST /teams/:teamId/transfers (see makeTransfer).
 */
export const getAvailableTransfers: ApiHandler = requireAuth(async (event, _session) => {
  const teamId = event.pathParameters?.teamId ?? "";
  const team = await teamsRepository.findById(teamId);
  if (!team) return notFoundResponse();

  const rosterSlots = await teamsRepository.findRosterSlots(teamId);
  const players = await playersRepository.findManyByIds(rosterSlots.map((slot) => slot.playerId));
  const playersWithStats = await attachPlayerStats(players);
  const playersWithStatsById = new Map(playersWithStats.map((player) => [player.id, player]));

  const currentGameweek = await gameweeksRepository.findCurrent();
  const matchesThisGameweek = currentGameweek ? await matchesRepository.findByGameweekId(currentGameweek.id) : [];
  const now = new Date();

  const findNextMatchForClub = (club: string) => {
    const clubMatches = matchesThisGameweek
      .filter((match) => match.homeClub === club || match.awayClub === club)
      .sort((firstMatch, secondMatch) => firstMatch.kickoffAt.getTime() - secondMatch.kickoffAt.getTime());
    const match = clubMatches.find((candidate) => candidate.status !== "COMPLETED") ?? clubMatches.at(-1);
    if (!match) return null;
    const playsAtHome = match.homeClub === club;
    return {
      opponent: playsAtHome ? match.awayClub : match.homeClub,
      home: playsAtHome,
      kickoffAt: match.kickoffAt,
      status: match.status,
    };
  };

  const roster = rosterSlots
    .map((slot) => {
      const player = playersWithStatsById.get(slot.playerId);
      if (!player) return null;
      return {
        ...player,
        isStarting: slot.isStarting,
        isLocked: isClubLocked(player.club, matchesThisGameweek, now),
        nextMatch: findNextMatchForClub(player.club),
      };
    })
    .filter((entry) => entry !== null);

  const transfersThisGameweek = currentGameweek
    ? await transfersRepository.findByTeamAndGameweek(teamId, currentGameweek.id)
    : [];
  const allTransferPlayerIds = transfersThisGameweek.flatMap((transfer) => [transfer.playerOutId, transfer.playerInId]);
  const transferPlayers = await playersRepository.findManyByIds(allTransferPlayerIds);
  const transferPlayerNamesById = new Map(transferPlayers.map((player) => [player.id, player.name]));
  const transfersThisGameweekWithNames = transfersThisGameweek.map((transfer) => ({
    ...transfer,
    playerOutName: transferPlayerNamesById.get(transfer.playerOutId) ?? transfer.playerOutId,
    playerInName: transferPlayerNamesById.get(transfer.playerInId) ?? transfer.playerInId,
  }));

  return jsonResponse(200, {
    currentGameweek: currentGameweek
      ? { number: currentGameweek.number, status: currentGameweek.status, deadlineAt: currentGameweek.deadlineAt }
      : null,
    bankedFreeTransferCount: team.bankedFreeTransferCount,
    maxBankedFreeTransferCount: MAX_BANKED_FREE_TRANSFER_COUNT,
    nextTransferPointsCost: team.bankedFreeTransferCount > 0 ? 0 : POINTS_COST_PER_PAID_TRANSFER,
    remainingBudgetInMillions: team.remainingBudgetInMillions,
    roster,
    transfersThisGameweek: transfersThisGameweekWithNames,
  });
});
