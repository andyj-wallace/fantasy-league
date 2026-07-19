"use client";

import { formatDayAndTime } from "@/app/lib/formatDate";
import type { CurrentGameweekResponse, GameweekMatchSummary } from "@/app/lib/gameweekContext";
import type { MatchStatus } from "../../domain";

const fixtureStatusBadges: Record<MatchStatus, { label: string; className: string } | null> = {
  SCHEDULED: null,
  IN_PROGRESS: { label: "Live", className: "badge badge-green" },
  COMPLETED: { label: "Full time", className: "badge" },
  POSTPONED: { label: "Postponed", className: "badge badge-red" },
  VOIDED: { label: "Voided", className: "badge badge-red" },
  DELAYED: { label: "Delayed", className: "badge badge-red" },
  INTERRUPTED: { label: "Interrupted", className: "badge badge-red" },
};

function FixtureRow({ match }: { match: GameweekMatchSummary }) {
  const statusBadge = fixtureStatusBadges[match.status];
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
 * exists yet has no matches scheduled. */
export function GameweekFixtures({ current }: { current: CurrentGameweekResponse | null }) {
  if (!current?.gameweek) return null;

  return (
    <>
      <h2>This gameweek</h2>
      {current.matches.length > 0 ? (
        <ul className="squad-list fixture-list">
          {current.matches.map((match) => (
            <FixtureRow key={match.id} match={match} />
          ))}
        </ul>
      ) : (
        <p>No matches are scheduled for this week.</p>
      )}
    </>
  );
}
