"use client";

import type { CurrentGameweekResponse } from "@/app/lib/useCurrentGameweek";
import type { GameweekStatus, LeagueStanding } from "../../domain";

export interface StandingEntry extends LeagueStanding {
  teamName: string;
  managerName: string;
}

export interface StandingsResponse {
  gameweek: { number: number; status: GameweekStatus } | null;
  standings: StandingEntry[];
}

/** The specified tooltip copy for the standings timestamp — see fantasy_league_user_flows_v1.txt. */
const STANDINGS_UPDATE_TOOLTIP =
  "Scores update shortly after each match ends. On busier days with several matches finishing close together, it can take a bit longer for every score to come through.";

/** The precomputed leaderboard for a league — heading with the gameweek it reflects, a
 * provisional/final note, the ranked table, and a last-updated timestamp. Handles its own
 * loading and empty states (a null response is still loading; an empty list has no scores yet).
 * `currentGameweek` is only used to word the empty state. */
export function LeagueStandingsSection({
  standingsResponse,
  currentGameweek,
}: {
  standingsResponse: StandingsResponse | null;
  currentGameweek: CurrentGameweekResponse | null;
}) {
  const standings = standingsResponse?.standings ?? null;
  const standingsGameweek = standingsResponse?.gameweek ?? null;
  const lastUpdatedAt =
    standings && standings.length > 0
      ? new Date(Math.max(...standings.map((standing) => new Date(standing.calculatedAt).getTime())))
      : null;

  return (
    <>
      <h2>
        Standings
        {standingsGameweek && ` — after Gameweek ${standingsGameweek.number}`}
      </h2>
      {standingsGameweek && (
        <p style={{ marginTop: "-0.35rem" }}>
          {standingsGameweek.status === "COMPLETED"
            ? "Final for this gameweek."
            : "Provisional — matches still in progress."}
        </p>
      )}
      {standings === null && <p>Loading…</p>}
      {standings !== null && standings.length === 0 && (
        <p>
          No standings yet —{" "}
          {currentGameweek?.gameweek
            ? `Gameweek ${currentGameweek.gameweek.number}'s scores appear here once its matches finish.`
            : "these appear once a gameweek's matches have been scored."}
        </p>
      )}
      {standings !== null && standings.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Team</th>
                  <th>Manager</th>
                  <th>Points</th>
                  <th>Goals</th>
                  <th>Banked</th>
                  <th>Spent</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((standing) => (
                  <tr key={standing.id}>
                    <td>{standing.rank}</td>
                    <td>{standing.teamName}</td>
                    <td>{standing.managerName}</td>
                    <td style={{ fontWeight: 700 }}>{standing.totalPoints}</td>
                    <td>{standing.tiebreakerStats.goalsScoredBySelectedPlayers}</td>
                    <td>{standing.tiebreakerStats.bankedFreeTransferCount}</td>
                    <td>£{standing.tiebreakerStats.totalSpentInMillions}M</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {lastUpdatedAt && (
            <p style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
              Updated automatically — busy match days may take a little longer.{" "}
              <span title={STANDINGS_UPDATE_TOOLTIP} style={{ cursor: "help", textDecoration: "underline dotted" }}>
                Last updated {lastUpdatedAt.toLocaleString()}
              </span>
            </p>
          )}
        </>
      )}
    </>
  );
}
