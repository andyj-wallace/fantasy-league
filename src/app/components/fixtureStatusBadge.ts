import type { MatchStatus } from "../../domain";

export interface FixtureStatusBadge {
  label: string;
  className: string;
}

/** A fixture's live window — 90 minutes plus stoppage and halftime, no extra time in league play.
 * Mirrors the worker's LIVE_FIXTURE_WINDOW_MINUTES. */
const LIVE_FIXTURE_WINDOW_MINUTES = 110;
/** Slack on top of the live window before a still-IN_PROGRESS row is treated as stale: a poll
 * interval has to elapse before the final whistle can even be observed, and a delayed kickoff we
 * never saw shifts the whole window later. Generous enough that a genuinely running match is
 * never mislabelled. */
const STALE_LIVE_STATUS_GRACE_MINUTES = 30;

const STALE_LIVE_STATUS_THRESHOLD_MS = (LIVE_FIXTURE_WINDOW_MINUTES + STALE_LIVE_STATUS_GRACE_MINUTES) * 60 * 1000;

const BADGE_BY_MATCH_STATUS: Record<MatchStatus, FixtureStatusBadge | null> = {
  SCHEDULED: null,
  IN_PROGRESS: { label: "Live", className: "badge badge-green" },
  COMPLETED: { label: "Full time", className: "badge" },
  POSTPONED: { label: "Postponed", className: "badge badge-red" },
  VOIDED: { label: "Voided", className: "badge badge-red" },
  DELAYED: { label: "Delayed", className: "badge badge-red" },
  INTERRUPTED: { label: "Interrupted", className: "badge badge-red" },
};

/** What a row shows once its IN_PROGRESS status has outlived any plausible match. Neutral rather
 * than green, and worded as a state rather than an event, so it reads as "we haven't heard" —
 * which is the truth — instead of asserting a match is being played right now. */
const STALE_LIVE_STATUS_BADGE: FixtureStatusBadge = { label: "In progress", className: "badge" };

/**
 * The badge for one fixture row. Status alone is not enough for IN_PROGRESS: a provider outage
 * (or any gap in the live-poll reconciliation described in
 * docs/stuck-live-match-reconciliation-plan.md) leaves the stored status frozen, and a flat lookup
 * would then show a green "Live" badge for a match that finished hours ago. Past the point where
 * a match could still be running, the badge degrades to a neutral one instead of lying.
 */
export function resolveFixtureStatusBadge(status: MatchStatus, kickoffAt: Date, now: Date): FixtureStatusBadge | null {
  if (status === "IN_PROGRESS" && now.getTime() - kickoffAt.getTime() > STALE_LIVE_STATUS_THRESHOLD_MS) {
    return STALE_LIVE_STATUS_BADGE;
  }
  return BADGE_BY_MATCH_STATUS[status];
}
