import { teamsRepository } from "../db/repositories";

/** Every gameweek earns every manager 2 free transfers (fantasy_league_v1_design.txt, "Transfers"),
 * capped at MAX_BANKED_FREE_TRANSFER_COUNT by the repository like every other banked award. */
const FREE_TRANSFERS_EARNED_PER_GAMEWEEK = 2;

/**
 * The GAMEWEEK_COMPLETED event from Fantasy League Architecture.txt: every Team earns its 2 free
 * transfers for the next gameweek once the round it belongs to has closed.
 *
 * This is a one-shot action with no ledger of its own — it adds to bankedFreeTransferCount and
 * nothing here can tell a first run from a second. Being once-per-gameweek is therefore the
 * caller's guarantee, and there is exactly one caller: processMatchDataChanges, which runs this
 * only when gameweeksRepository.markCompletedIfNotAlready reports that its own conditional UPDATE
 * was the statement that closed this round. The gameweek id is taken here rather than inferred so
 * the log line names the round being settled — two rounds closing in the same worker cycle is a
 * real and correct outcome (a postponed fixture replayed weeks later closes its original round
 * alongside the current one, and each round owes its own 2), and a log that could not tell them
 * apart made that indistinguishable from a double award.
 */
export async function awardGameweekFreeTransfers(completedGameweekId: string): Promise<void> {
  const teams = await teamsRepository.findAll();
  for (const team of teams) {
    await teamsRepository.incrementBankedFreeTransferCount(team.id, FREE_TRANSFERS_EARNED_PER_GAMEWEEK);
  }
  console.log(
    `[awardGameweekFreeTransfers] gameweek ${completedGameweekId} closed — ` +
      `+${FREE_TRANSFERS_EARNED_PER_GAMEWEEK} free transfers to ${teams.length} team(s)`,
  );
}
