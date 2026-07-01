import { calculateNewPriceInMillions } from "../domain";
import { playerScoresRepository, playersRepository, teamsRepository, transfersRepository } from "../db/repositories";

/** Rolling window used for the transfer-activity signal — how far back to count transfers in/out. */
const TRANSFER_ACTIVITY_WINDOW_DAYS = 30;

/**
 * Recalculates every Player's market price using three signals: recent form (50%), transfer
 * activity over the last 30 days (25%), and current ownership percentage (25%). See
 * calculateNewPriceInMillions in domain/playerPricing.ts for the full formula and constants.
 *
 * Runs once a month via the scheduler. Touches every Player row with a new price, even if the
 * delta is £0 (idempotent re-run safe). The formula is intentionally tunable — adjust weights
 * and constants in playerPricing.ts without changing this orchestration logic.
 */
export async function runMonthlyPriceUpdate(): Promise<void> {
  const players = await playersRepository.findMany({});
  if (players.length === 0) return;

  const playerIds = players.map((player) => player.id);
  const since = new Date(Date.now() - TRANSFER_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [allScores, transferVolumes, ownershipCounts, totalTeams] = await Promise.all([
    playerScoresRepository.findManyByPlayerIds(playerIds),
    transfersRepository.findTransferVolumeByPlayerIds(playerIds, since),
    teamsRepository.countRosteringByPlayerIds(playerIds),
    teamsRepository.countAll(),
  ]);

  const recentPointsByPlayerId = new Map<string, number[]>();
  for (const score of allScores) {
    const existing = recentPointsByPlayerId.get(score.playerId) ?? [];
    existing.push(score.totalPoints);
    recentPointsByPlayerId.set(score.playerId, existing);
  }

  const transfersInByPlayerId = new Map(transferVolumes.map(({ playerId, transfersIn }) => [playerId, transfersIn]));
  const transfersOutByPlayerId = new Map(transferVolumes.map(({ playerId, transfersOut }) => [playerId, transfersOut]));
  const ownershipByPlayerId = new Map(ownershipCounts.map(({ playerId, teamsRostering }) => [playerId, teamsRostering]));

  for (const player of players) {
    const newPrice = calculateNewPriceInMillions({
      recentPointsNewestFirst: recentPointsByPlayerId.get(player.id) ?? [],
      transfersIn: transfersInByPlayerId.get(player.id) ?? 0,
      transfersOut: transfersOutByPlayerId.get(player.id) ?? 0,
      totalTeams,
      teamsRostering: ownershipByPlayerId.get(player.id) ?? 0,
    });
    await playersRepository.updatePrice(player.id, newPrice);
  }
}
