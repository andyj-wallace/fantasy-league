"use client";

import type { CurrentGameweekResponse } from "@/app/lib/gameweekContext";
import { summarizeGameweekMatchProgress, type GameweekStatus, type LeagueStanding } from "../../domain";

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

/**
 * Why the table is empty, said precisely. Standings are written only once every match in the
 * gameweek is final — not per match as they finish — so mid-gameweek the honest answer includes
 * how many fixtures are still outstanding. Without that count an empty leaderboard during a
 * gameweek reads as breakage rather than as "not yet".
 */
function emptyStandingsExplanation(currentGameweek: CurrentGameweekResponse | null): string {
  const gameweek = currentGameweek?.gameweek;
  if (!gameweek) return "No standings yet — these appear once a gameweek's matches have been scored.";

  const progress = summarizeGameweekMatchProgress(currentGameweek?.matches ?? []);
  if (progress.totalMatchCount === 0) {
    return `No standings yet — Gameweek ${gameweek.number}'s fixtures haven't been published yet.`;
  }
  if (progress.isGameweekFullyPlayed) {
    return `No standings yet — Gameweek ${gameweek.number}'s matches have all finished, so scores are being calculated.`;
  }
  const outstandingMatchCount = progress.totalMatchCount - progress.finalizedMatchCount;
  return (
    `No standings yet — Gameweek ${gameweek.number} is ${progress.finalizedMatchCount} of ` +
    `${progress.totalMatchCount} matches in. Standings appear once the remaining ` +
    `${outstandingMatchCount === 1 ? "match has" : `${outstandingMatchCount} matches have`} finished. ` +
    `Your players' points so far are in the Squad Builder.`
  );
}

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
      {standings !== null && standings.length === 0 && <p>{emptyStandingsExplanation(currentGameweek)}</p>}
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
