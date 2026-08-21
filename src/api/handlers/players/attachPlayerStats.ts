import { playerScoresRepository } from "../../../db/repositories";
import {
  deriveRecentFormPoints,
  type Player,
  type PlayerGameweekPoints,
  type PlayerWithStats,
} from "../../../domain";

/** Enriches Players with totalFantasyPoints/recentFormPoints/pointsByGameweekNumber from
 * PlayerScore history — shared by searchPlayers and getPlayer so both surface the same
 * squad-builder player card data. One query for every player asked about, regardless of count.
 *
 * Rows arrive newest gameweek first and are folded per player into both shapes the UI needs: the
 * flat newest-first list behind total points and recent form, and the per-gameweek map behind the
 * squad builder's "how is my team doing this week" summary. Two rows sharing a gameweek — a
 * postponed fixture replayed under its original round label — are summed, never overwritten,
 * matching how playerScoresRepository.findPlayerGameweekPoints collapses the same case. */
export async function attachPlayerStats(players: Player[]): Promise<PlayerWithStats[]> {
  const scores = await playerScoresRepository.findManyByPlayerIds(players.map((player) => player.id));
  const pointsNewestFirstByPlayerId = new Map<string, number[]>();
  const pointsByGameweekNumberByPlayerId = new Map<string, Record<number, PlayerGameweekPoints>>();
  for (const score of scores) {
    const existing = pointsNewestFirstByPlayerId.get(score.playerId) ?? [];
    existing.push(score.totalPoints);
    pointsNewestFirstByPlayerId.set(score.playerId, existing);

    const byGameweekNumber = pointsByGameweekNumberByPlayerId.get(score.playerId) ?? {};
    const alreadyScored = byGameweekNumber[score.gameweekNumber];
    byGameweekNumber[score.gameweekNumber] = {
      totalPoints: (alreadyScored?.totalPoints ?? 0) + score.totalPoints,
      didAppear: (alreadyScored?.didAppear ?? false) || score.didAppear,
    };
    pointsByGameweekNumberByPlayerId.set(score.playerId, byGameweekNumber);
  }

  return players.map((player) => {
    const pointsNewestFirst = pointsNewestFirstByPlayerId.get(player.id) ?? [];
    return {
      ...player,
      totalFantasyPoints: pointsNewestFirst.reduce((sum, points) => sum + points, 0),
      recentFormPoints: deriveRecentFormPoints(pointsNewestFirst),
      pointsByGameweekNumber: pointsByGameweekNumberByPlayerId.get(player.id) ?? {},
    };
  });
}
