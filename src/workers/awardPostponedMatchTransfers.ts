import { matchesRepository, teamsRepository } from "../db/repositories";

/**
 * 1 free transfer per affected club for every Team rostering a player from that club (per
 * fantasy_league_v1_design.txt). A Match always has exactly 2 clubs, so a Team with players from
 * both nets 2 — matching the doc's "Arsenal and Liverpool affected -> 2 free transfers" example.
 */
export async function awardPostponedMatchTransfers(matchId: string): Promise<void> {
  const match = await matchesRepository.findById(matchId);
  if (!match) return;

  const affectedClubs = [match.homeClub, match.awayClub];
  for (const club of affectedClubs) {
    const teamIds = await teamsRepository.findTeamIdsWithPlayerFromClub(club);
    for (const teamId of teamIds) {
      await teamsRepository.incrementBankedFreeTransferCount(teamId);
    }
  }
}
