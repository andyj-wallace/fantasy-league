"use client";

import { resolveCaptainBonusPlayerId, type GameweekMatchProgress, type PlayerWithStats } from "@/domain";

/**
 * The manager-facing reconciliation of a gameweek's scoring: what each of the 16 squad players has
 * banked so far, the armband bonus as its own line, and the running total those two add up to.
 *
 * The captain bonus is shown rather than folded into the total on purpose. A manager checking the
 * arithmetic sums the per-player column, and that sum will never match the team total on its own —
 * calculateTeamScores counts the armband holder's points a second time. An unexplained gap reads as
 * a bug, so the line that closes it is part of the feature, not decoration.
 *
 * Points here come from PlayerScore rows, which are written per match as each one finishes. So this
 * is a running tally of completed matches, not live in-play scoring: a player whose match is still
 * being played contributes nothing yet, which is what `matchProgress` exists to explain.
 */
export function SquadGameweekSummary({
  gameweekNumber,
  squadPlayers,
  captainPlayerId,
  viceCaptainPlayerId,
  matchProgress,
}: {
  gameweekNumber: number;
  squadPlayers: PlayerWithStats[];
  captainPlayerId: string;
  viceCaptainPlayerId: string;
  matchProgress: GameweekMatchProgress;
}) {
  const gameweekPointsOf = (playerId: string) =>
    squadPlayers.find((player) => player.id === playerId)?.pointsByGameweekNumber[gameweekNumber] ?? null;

  const squadPointsTotal = squadPlayers.reduce(
    (runningTotal, player) => runningTotal + (player.pointsByGameweekNumber[gameweekNumber]?.totalPoints ?? 0),
    0,
  );

  const captainBonusPlayerId = resolveCaptainBonusPlayerId(
    { playerId: captainPlayerId || null, gameweekPoints: gameweekPointsOf(captainPlayerId) },
    { playerId: viceCaptainPlayerId || null, gameweekPoints: gameweekPointsOf(viceCaptainPlayerId) },
  );
  const captainBonusPlayer = squadPlayers.find((player) => player.id === captainBonusPlayerId) ?? null;
  const captainBonusPoints = captainBonusPlayerId ? (gameweekPointsOf(captainBonusPlayerId)?.totalPoints ?? 0) : 0;

  const scoredPlayerCount = squadPlayers.filter(
    (player) => player.pointsByGameweekNumber[gameweekNumber] !== undefined,
  ).length;

  return (
    <section className="gameweek-summary" aria-label={`Gameweek ${gameweekNumber} points so far`}>
      <h3>Gameweek {gameweekNumber} so far</h3>
      <p className="gameweek-summary-progress">
        {matchProgress.totalMatchCount === 0
          ? "Fixtures for this gameweek haven't been published yet."
          : matchProgress.isGameweekFullyPlayed
            ? `All ${matchProgress.totalMatchCount} matches played — final once standings update.`
            : `${matchProgress.finalizedMatchCount} of ${matchProgress.totalMatchCount} matches played · ${scoredPlayerCount} of ${squadPlayers.length} of your players have scored so far.`}
      </p>

      <dl className="gameweek-summary-lines">
        <div>
          <dt>Squad points</dt>
          <dd>{squadPointsTotal}</dd>
        </div>
        <div>
          <dt>
            Captain bonus
            {captainBonusPlayer && <span className="gameweek-summary-note"> · {captainBonusPlayer.name}</span>}
            {!captainBonusPlayer && (
              <span className="gameweek-summary-note">
                {" "}
                · {captainPlayerId || viceCaptainPlayerId ? "not yet played" : "no captain set"}
              </span>
            )}
          </dt>
          <dd>{captainBonusPoints > 0 ? `+${captainBonusPoints}` : captainBonusPoints}</dd>
        </div>
        <div className="gameweek-summary-total">
          <dt>Gameweek total</dt>
          <dd>{squadPointsTotal + captainBonusPoints}</dd>
        </div>
      </dl>

      {!matchProgress.isGameweekFullyPlayed && (
        <p className="gameweek-summary-footnote">
          Standings update once every match in the gameweek has finished.
        </p>
      )}
    </section>
  );
}
