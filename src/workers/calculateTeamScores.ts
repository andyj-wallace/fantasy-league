import { randomUUID } from "node:crypto";
import { playerScoresRepository, teamScoresRepository, teamsRepository } from "../db/repositories";
import { resolveCaptainBonusPlayerId } from "../domain";
import type { PlayerGameweekPoints, TeamScore } from "../domain";

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

      const gameweekPointsByPlayerId = new Map<string, PlayerGameweekPoints | null>();
      async function gameweekPointsFor(playerId: string): Promise<PlayerGameweekPoints | null> {
        if (!gameweekPointsByPlayerId.has(playerId)) {
          gameweekPointsByPlayerId.set(playerId, await playerScoresRepository.findPlayerGameweekPoints(playerId, gameweekId));
        }
        return gameweekPointsByPlayerId.get(playerId) ?? null;
      }

      let totalPoints = 0;
      for (const slot of rosterSlots) {
        const playerGameweekPoints = await gameweekPointsFor(slot.playerId);
        totalPoints += playerGameweekPoints?.totalPoints ?? 0;
      }

      // Captain may be unset (no squad/lineup chosen yet) as well as simply not having played
      // this gameweek — either way, fall back to the vice-captain. The rule itself lives in the
      // domain so the squad builder's gameweek summary can show the same armband holder.
      const captainBonusPlayerId = resolveCaptainBonusPlayerId(
        {
          playerId: team.captainPlayerId,
          gameweekPoints: team.captainPlayerId ? await gameweekPointsFor(team.captainPlayerId) : null,
        },
        {
          playerId: team.viceCaptainPlayerId,
          gameweekPoints: team.viceCaptainPlayerId ? await gameweekPointsFor(team.viceCaptainPlayerId) : null,
        },
      );
      if (captainBonusPlayerId) {
        totalPoints += (await gameweekPointsFor(captainBonusPlayerId))?.totalPoints ?? 0;
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
