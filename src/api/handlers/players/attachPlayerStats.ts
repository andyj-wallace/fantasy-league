import { playerScoresRepository } from "../../../db/repositories";
import { deriveRecentFormPoints, type Player, type PlayerWithStats } from "../../../domain";

/** Enriches Players with totalFantasyPoints/recentFormPoints from PlayerScore history — shared
 * by searchPlayers and getPlayer so both surface the same squad-builder player card data. */
export async function attachPlayerStats(players: Player[]): Promise<PlayerWithStats[]> {
  const scores = await playerScoresRepository.findManyByPlayerIds(players.map((player) => player.id));
  const pointsNewestFirstByPlayerId = new Map<string, number[]>();
  for (const score of scores) {
    const existing = pointsNewestFirstByPlayerId.get(score.playerId) ?? [];
    existing.push(score.totalPoints);
    pointsNewestFirstByPlayerId.set(score.playerId, existing);
  }

  return players.map((player) => {
    const pointsNewestFirst = pointsNewestFirstByPlayerId.get(player.id) ?? [];
    return {
      ...player,
      totalFantasyPoints: pointsNewestFirst.reduce((sum, points) => sum + points, 0),
      recentFormPoints: deriveRecentFormPoints(pointsNewestFirst),
    };
  });
}
