import type { GameweekStatus } from "./shared";

/** Whether a manager may see another manager's picks yet, and when that changes. */
export interface RivalSquadVisibility {
  isSquadVisible: boolean;
  /** When the squad becomes visible, for "hidden until …" copy. Null when already visible or
   * when no gameweek deadline is known yet. */
  revealsAt: Date | null;
}

/**
 * A rival's roster, formation and captaincy are strategy and stay hidden until the current
 * gameweek's deadline has passed. The status check exists alongside the clock check because a
 * gameweek the worker has already moved to LOCKED/IN_PROGRESS/COMPLETED must never re-hide on a
 * clock skew between this request and whatever set deadlineAt — status is the authoritative,
 * already-committed answer; the clock is only a fallback for a gameweek still UPCOMING.
 */
export function resolveRivalSquadVisibility(input: {
  currentGameweek: { status: GameweekStatus; deadlineAt: Date } | null;
  /** Only consulted when there is no current gameweek: distinguishes "season is over" (reveal)
   * from "no fixtures imported yet" (hide). */
  hasCompletedGameweek: boolean;
  now: Date;
}): RivalSquadVisibility {
  const { currentGameweek, hasCompletedGameweek, now } = input;

  if (currentGameweek === null) {
    return { isSquadVisible: hasCompletedGameweek, revealsAt: null };
  }
  if (currentGameweek.status === "LOCKED" || currentGameweek.status === "IN_PROGRESS" || currentGameweek.status === "COMPLETED") {
    return { isSquadVisible: true, revealsAt: null };
  }
  if (currentGameweek.deadlineAt <= now) {
    return { isSquadVisible: true, revealsAt: null };
  }
  return { isSquadVisible: false, revealsAt: currentGameweek.deadlineAt };
}
