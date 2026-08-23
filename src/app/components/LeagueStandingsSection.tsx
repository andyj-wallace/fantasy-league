"use client";

import type { CurrentGameweekResponse } from "@/app/lib/gameweekContext";
import { summarizeGameweekMatchProgress, type GameweekStatus, type LeagueStanding } from "../../domain";

export interface StandingEntry extends LeagueStanding {
  teamName: string;
  managerName: string;
}

export interface StandingsResponse {
  gameweek: { number: number; status: GameweekStatus } | null;
  /** True while the table is the opening-day baseline — every team present, nobody scored yet. */
  isAwaitingFirstScoredGameweek: boolean;
  standings: StandingEntry[];
}

/** The specified tooltip copy for the standings timestamp — see fantasy_league_user_flows_v1.txt. */
const STANDINGS_UPDATE_TOOLTIP =
  "Scores update shortly after each match ends. On busier days with several matches finishing close together, it can take a bit longer for every score to come through.";

/**
 * What to say above the opening-day table, where every team sits on zero. The table itself answers
 * "who is in this league"; this answers "why is everyone on nothing", which mid-gameweek means
 * naming how many fixtures are still to come.
 */
function unscoredStandingsNote(currentGameweek: CurrentGameweekResponse | null): string {
  const gameweek = currentGameweek?.gameweek;
  if (!gameweek) return "Nobody has scored yet — the table fills in once a gameweek's matches are played.";

  const progress = summarizeGameweekMatchProgress(currentGameweek?.matches ?? []);
  if (progress.totalMatchCount === 0) {
    return `Everyone starts level — Gameweek ${gameweek.number}'s fixtures haven't been published yet.`;
  }
  if (progress.isGameweekFullyPlayed) {
    return `Gameweek ${gameweek.number}'s matches have all finished — scores are being calculated.`;
  }
  const outstandingMatchCount = progress.totalMatchCount - progress.finalizedMatchCount;
  return (
    `Everyone starts level — Gameweek ${gameweek.number} is ${progress.finalizedMatchCount} of ` +
    `${progress.totalMatchCount} matches in, with ` +
    `${outstandingMatchCount === 1 ? "1 still to finish" : `${outstandingMatchCount} still to finish`}. ` +
    `Points land here as matches end.`
  );
}

/** Which gameweek the table reflects, and how settled it is. The baseline table has no scored
 * gameweek of its own, so it borrows the current one to say where the season is. */
function describeStandingsGameweek(
  standingsGameweek: { number: number; status: GameweekStatus } | null,
  currentGameweek: CurrentGameweekResponse | null,
  isAwaitingFirstScoredGameweek: boolean,
): { headingSuffix: string; note: string | null } {
  if (isAwaitingFirstScoredGameweek) {
    const currentNumber = currentGameweek?.gameweek?.number;
    return {
      headingSuffix: currentNumber === undefined ? "" : ` — before Gameweek ${currentNumber}`,
      note: null, // the unscored note below carries the explanation instead
    };
  }
  if (!standingsGameweek) return { headingSuffix: "", note: null };

  return standingsGameweek.status === "COMPLETED"
    ? { headingSuffix: ` — after Gameweek ${standingsGameweek.number}`, note: "Final for this gameweek." }
    : {
        headingSuffix: ` — Gameweek ${standingsGameweek.number} so far`,
        note: "Provisional — matches still in progress.",
      };
}

/** The precomputed leaderboard for a league — heading with the gameweek it reflects, a
 * provisional/final note, the ranked table, and a last-updated timestamp. Handles its own
 * loading and empty states (a null response is still loading; an empty list means the league has
 * no teams yet — every league with managers in it has a table, even before a ball is kicked).
 * `currentGameweek` words the opening-day note and heading. */
export function LeagueStandingsSection({
  standingsResponse,
  currentGameweek,
}: {
  standingsResponse: StandingsResponse | null;
  currentGameweek: CurrentGameweekResponse | null;
}) {
  const standings = standingsResponse?.standings ?? null;
  const isAwaitingFirstScoredGameweek = standingsResponse?.isAwaitingFirstScoredGameweek ?? false;
  const { headingSuffix, note } = describeStandingsGameweek(
    standingsResponse?.gameweek ?? null,
    currentGameweek,
    isAwaitingFirstScoredGameweek,
  );
  const lastUpdatedAt =
    standings && standings.length > 0 && !isAwaitingFirstScoredGameweek
      ? new Date(Math.max(...standings.map((standing) => new Date(standing.calculatedAt).getTime())))
      : null;

  return (
    <>
      <h2>Standings{headingSuffix}</h2>
      {note && <p style={{ marginTop: "-0.35rem" }}>{note}</p>}
      {standings === null && <p>Loading…</p>}
      {standings !== null && standings.length === 0 && (
        <p>No teams in this league yet — share the invite code above and the table fills in as managers join.</p>
      )}
      {standings !== null && standings.length > 0 && (
        <>
          {isAwaitingFirstScoredGameweek && (
            <p style={{ marginTop: "-0.35rem" }}>{unscoredStandingsNote(currentGameweek)}</p>
          )}
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
