import "dotenv/config";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { gameweeks, leagues, matches } from "../db/schema";
import { gameweeksRepository } from "../db/repositories";
import { calculatePlayerScores } from "../workers/calculatePlayerScores";
import { calculateTeamScores } from "../workers/calculateTeamScores";
import { updateStandings } from "../workers/updateStandings";

/**
 * Companion to seed6GameweekSmokeTest.ts: runs the scoring cascade over the seeded completed
 * matches and marks Gameweeks 1-3 COMPLETED — the same end state a real worker cycle produces,
 * without touching the live football API (whose free plan can't serve the seeded season).
 * After running, /gameweeks/current returns Gameweek 4 and league standings exist for GW1-3,
 * which is the state the season-awareness UI needs for manual testing.
 *
 *   npx tsx src/testing/completeSeededGameweeks.ts
 */
async function completeSeededGameweeks() {
  const allLeagues = await db.select().from(leagues);
  console.log(`${allLeagues.length} leagues found`);

  for (const gameweekNumber of [1, 2, 3]) {
    const [gameweek] = await db.select().from(gameweeks).where(eq(gameweeks.number, gameweekNumber));
    if (!gameweek) throw new Error(`Gameweek ${gameweekNumber} not seeded — run seed6GameweekSmokeTest.ts first`);
    const gameweekMatches = await db
      .select()
      .from(matches)
      .where(eq(matches.gameweekId, gameweek.id))
      .orderBy(asc(matches.kickoffAt));

    for (const match of gameweekMatches.filter((match) => match.status === "COMPLETED")) {
      await calculatePlayerScores(match.id);
    }
    await calculateTeamScores(gameweek.id);
    for (const league of allLeagues) {
      await updateStandings(league.id, gameweek.id);
    }
    await gameweeksRepository.markCompleted(gameweek.id);
    console.log(
      `Gameweek ${gameweekNumber}: scored ${gameweekMatches.length} matches, standings updated, marked COMPLETED`,
    );
  }
  process.exit(0);
}

completeSeededGameweeks().catch((error) => {
  console.error(error);
  process.exit(1);
});
