import { teamsRepository } from "../db/repositories";

/**
 * The GAMEWEEK_COMPLETED event from Fantasy League Architecture.txt: every Team earns its 2
 * free transfers for the next gameweek once the current one's matches all finish (capped at
 * MAX_BANKED_FREE_TRANSFER_COUNT, same as every other banked-transfer award).
 */
export async function awardGameweekFreeTransfers(): Promise<void> {
  const teams = await teamsRepository.findAll();
  for (const team of teams) {
    await teamsRepository.incrementBankedFreeTransferCount(team.id, 2);
  }
}
