"use client";

import { useCurrentGameweekContext, type CurrentGameweekResponse } from "@/app/lib/gameweekContext";
import { formatDayAndTime } from "@/app/lib/formatDate";
import type { GameweekStatus } from "../../domain";

const gameweekStatusBadges: Record<GameweekStatus, { label: string; className: string }> = {
  UPCOMING: { label: "Upcoming", className: "badge badge-blue" },
  LOCKED: { label: "Locked", className: "badge" },
  IN_PROGRESS: { label: "In progress", className: "badge badge-green" },
  COMPLETED: { label: "Completed", className: "badge" },
};

/** The season-context strip shown at the top of league, transfers, and squad-builder pages:
 * which gameweek it is, its status, and the transfer/lineup deadline. Renders nothing while
 * loading or when no gameweek exists yet (pre-season, empty database).
 * Pass `current` when the page already fetched /gameweeks/current itself; omit it to let the
 * banner fetch on its own. */
export function GameweekBanner({ current }: { current?: CurrentGameweekResponse | null }) {
  const fetchedCurrent = useCurrentGameweekContext();
  const resolvedCurrent = current !== undefined ? current : fetchedCurrent;
  if (!resolvedCurrent?.gameweek) return null;

  const { gameweek } = resolvedCurrent;
  const statusBadge = gameweekStatusBadges[gameweek.status];
  const deadlineHasPassed = new Date(gameweek.deadlineAt).getTime() < Date.now();

  return (
    <div className="gameweek-banner">
      <strong>Gameweek {gameweek.number}</strong>
      <span className={statusBadge.className}>{statusBadge.label}</span>
      <span className="gameweek-banner-deadline">
        {deadlineHasPassed
          ? `Deadline passed (${formatDayAndTime(gameweek.deadlineAt)})`
          : `Deadline ${formatDayAndTime(gameweek.deadlineAt)}`}
      </span>
    </div>
  );
}
