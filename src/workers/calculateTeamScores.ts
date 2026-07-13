import { randomUUID } from "node:crypto";
import { playerScoresRepository, teamScoresRepository, teamsRepository } from "../db/repositories";
import type { TeamScore } from "../domain";

/**
 * Turns each Team's roster of PlayerScores into one TeamScore for the gameweek. Bench players
 * count directly (no auto-subs in V1) and the captain's points are added a second time to
 * realize the 2x bonus — falling back to the vice-captain if the captain didn't play, which
 * means either no PlayerScore row at all or one with zero appearance points (an unused sub).
 */
export async function calculateTeamScores(gameweekId: string): Promise<void> {
  const teams = await teamsRepository.findAll();

  const scores: TeamScore[] = await Promise.all(
    teams.map(async (team) => {
      const rosterSlots = await teamsRepository.findRosterSlots(team.id);

      let totalPoints = 0;
      for (const slot of rosterSlots) {
        const playerScore = await playerScoresRepository.findByPlayerAndGameweek(slot.playerId, gameweekId);
        totalPoints += playerScore?.totalPoints ?? 0;
      }

      // Captain may be unset (no squad/lineup chosen yet) as well as simply not having played
      // this gameweek — either way, fall back to the vice-captain.
      let captainBonusPlayerId: string | null = null;
      if (team.captainPlayerId) {
        const captainScore = await playerScoresRepository.findByPlayerAndGameweek(team.captainPlayerId, gameweekId);
        if (captainScore && captainScore.breakdown.appearancePoints > 0) {
          totalPoints += captainScore.totalPoints;
          captainBonusPlayerId = team.captainPlayerId;
        }
      }
      if (!captainBonusPlayerId && team.viceCaptainPlayerId) {
        const viceCaptainScore = await playerScoresRepository.findByPlayerAndGameweek(
          team.viceCaptainPlayerId,
          gameweekId,
        );
        if (viceCaptainScore && viceCaptainScore.breakdown.appearancePoints > 0) {
          totalPoints += viceCaptainScore.totalPoints;
          captainBonusPlayerId = team.viceCaptainPlayerId;
        }
      }

      return {
        id: randomUUID(),
        teamId: team.id,
        gameweekId,
        captainBonusPlayerId,
        totalPoints,
        calculatedAt: new Date(),
      };
    }),
  );

  await teamScoresRepository.replaceForGameweek(gameweekId, scores);
}
