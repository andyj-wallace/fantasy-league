import {
  gameweeksRepository,
  teamScoresRepository,
  teamsRepository,
  transfersRepository,
  usersRepository,
} from "../../../db/repositories";
import { resolveRivalSquadVisibility } from "../../../domain";
import { requireAuth } from "../../auth";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

/**
 * The read-only "pitch + team sheet" view of another manager's team inside a shared league:
 * roster, formation and captaincy once resolveRivalSquadVisibility says the current gameweek's
 * deadline has passed — always visible for the viewer's own team, deadline or not. One
 * findByLeagueId call answers three questions at once — does the target team exist, is it in
 * this league, and is the viewer a member of it — and already excludes soft-removed teams, so a
 * non-member and a removed team both fall through to the same 404 without confirming which case
 * it was.
 *
 * The hidden payload is an explicit early return rather than conditionally-blanked fields at the
 * end, and never reads the roster/transfers/score at all — a leak here is the whole risk of the
 * feature.
 */
export const getLeagueTeamSquad: ApiHandler = requireAuth(async (event, session) => {
  const leagueId = event.pathParameters?.leagueId ?? "";
  const teamId = event.pathParameters?.teamId ?? "";

  const leagueTeams = await teamsRepository.findByLeagueId(leagueId);
  const viewerTeam = leagueTeams.find((team) => team.userId === session.userId);
  const requestedTeam = leagueTeams.find((team) => team.id === teamId);
  if (!viewerTeam || !requestedTeam) return notFoundResponse();

  const [users, currentGameweek] = await Promise.all([
    usersRepository.findManyByIds([requestedTeam.userId]),
    gameweeksRepository.findCurrent(),
  ]);
  const managerName = users[0]?.displayName ?? requestedTeam.userId;
  const gameweekNumber = currentGameweek?.number ?? null;

  const isViewersOwnTeam = requestedTeam.id === viewerTeam.id;
  const latestCompletedGameweek = currentGameweek ? null : await gameweeksRepository.findLatestCompleted();
  const visibility = resolveRivalSquadVisibility({
    currentGameweek,
    hasCompletedGameweek: latestCompletedGameweek !== null,
    now: new Date(),
  });
  const isSquadVisible = isViewersOwnTeam || visibility.isSquadVisible;

  if (!isSquadVisible) {
    return jsonResponse(200, {
      team: {
        id: requestedTeam.id,
        leagueId: requestedTeam.leagueId,
        name: requestedTeam.name,
        formation: null,
        captainPlayerId: null,
        viceCaptainPlayerId: null,
        remainingBudgetInMillions: requestedTeam.remainingBudgetInMillions,
        bankedFreeTransferCount: requestedTeam.bankedFreeTransferCount,
      },
      managerName,
      isViewersOwnTeam,
      isSquadVisible: false,
      revealsAt: visibility.revealsAt,
      rosterSlots: [],
      gameweekNumber,
      gameweekTotalPoints: null,
      transferPointsCostThisGameweek: 0,
      paidTransferCountThisGameweek: 0,
    });
  }

  const [rosterSlots, transfersThisGameweek, teamScore] = await Promise.all([
    teamsRepository.findRosterSlots(requestedTeam.id),
    currentGameweek
      ? transfersRepository.findByTeamAndGameweek(requestedTeam.id, currentGameweek.id)
      : Promise.resolve([]),
    currentGameweek ? teamScoresRepository.findByTeamAndGameweek(requestedTeam.id, currentGameweek.id) : Promise.resolve(null),
  ]);
  const paidTransfersThisGameweek = transfersThisGameweek.filter((transfer) => transfer.pointsCost > 0);

  return jsonResponse(200, {
    team: {
      id: requestedTeam.id,
      leagueId: requestedTeam.leagueId,
      name: requestedTeam.name,
      formation: requestedTeam.formation,
      captainPlayerId: requestedTeam.captainPlayerId,
      viceCaptainPlayerId: requestedTeam.viceCaptainPlayerId,
      remainingBudgetInMillions: requestedTeam.remainingBudgetInMillions,
      bankedFreeTransferCount: requestedTeam.bankedFreeTransferCount,
    },
    managerName,
    isViewersOwnTeam,
    isSquadVisible: true,
    revealsAt: null,
    rosterSlots,
    gameweekNumber,
    gameweekTotalPoints: teamScore?.totalPoints ?? null,
    transferPointsCostThisGameweek: paidTransfersThisGameweek.reduce(
      (runningPointsCost, transfer) => runningPointsCost + transfer.pointsCost,
      0,
    ),
    paidTransferCountThisGameweek: paidTransfersThisGameweek.length,
  });
});
