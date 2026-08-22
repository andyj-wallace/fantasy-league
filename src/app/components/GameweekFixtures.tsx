"use client";

import { formatDayAndTime } from "@/app/lib/formatDate";
import type { CurrentGameweekResponse, GameweekMatchSummary } from "@/app/lib/gameweekContext";
import { resolveFixtureStatusBadge } from "./fixtureStatusBadge";

function FixtureRow({ match, renderedAt }: { match: GameweekMatchSummary; renderedAt: Date }) {
  const statusBadge = resolveFixtureStatusBadge(match.status, new Date(match.kickoffAt), renderedAt);
  const hasFinalScore = match.finalHomeScore !== null && match.finalAwayScore !== null;
  return (
    <li>
      <span className="fixture-teams">
        {match.homeClub} v {match.awayClub}
      </span>
      {hasFinalScore && (
        <span className="fixture-score">
          {match.finalHomeScore}–{match.finalAwayScore}
        </span>
      )}
      {statusBadge && <span className={statusBadge.className}>{statusBadge.label}</span>}
      <span className="fixture-kickoff">{formatDayAndTime(match.kickoffAt)}</span>
    </li>
  );
}

/** The "This gameweek" fixtures list shown on the league page. Renders nothing when there is no
 * current gameweek at all, but keeps its heading with an empty-state line for a gameweek that
 * exists yet has no matches scheduled. The render clock is read once and shared by every row, so
 * two fixtures in the same list can't disagree about how stale "live" is. */
export function GameweekFixtures({ current }: { current: CurrentGameweekResponse | null }) {
  if (!current?.gameweek) return null;
  const renderedAt = new Date();

  return (
    <>
      <h2>This gameweek</h2>
      {current.matches.length > 0 ? (
        <ul className="squad-list fixture-list">
          {current.matches.map((match) => (
            <FixtureRow key={match.id} match={match} renderedAt={renderedAt} />
          ))}
        </ul>
      ) : (
        <p>No matches are scheduled for this week.</p>
      )}
    </>
  );
}
