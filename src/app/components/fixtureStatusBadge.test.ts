import { describe, expect, it } from "vitest";
import { resolveFixtureStatusBadge } from "./fixtureStatusBadge";

/**
 * The badge's staleness guard (Phase 4 of docs/stuck-live-match-reconciliation-plan.md). Backend
 * reconciliation is what actually keeps a Match row moving, but a provider outage can still freeze
 * one at IN_PROGRESS — and a badge derived from status alone then shows a green "Live" for a match
 * that finished hours ago. These pin that the label degrades instead of lying.
 */
const KICKOFF_AT = new Date("2026-08-21T19:00:00Z");

function minutesAfterKickoff(minutes: number): Date {
  return new Date(KICKOFF_AT.getTime() + minutes * 60 * 1000);
}

describe("resolveFixtureStatusBadge", () => {
  it("shows a live badge for a match in progress inside its plausible window", () => {
    expect(resolveFixtureStatusBadge("IN_PROGRESS", KICKOFF_AT, minutesAfterKickoff(40))).toEqual({
      label: "Live",
      className: "badge badge-green",
    });
  });

  it("still shows it live in stoppage time, past the 90 minutes but inside the window", () => {
    expect(resolveFixtureStatusBadge("IN_PROGRESS", KICKOFF_AT, minutesAfterKickoff(115))?.className).toBe(
      "badge badge-green",
    );
  });

  it("degrades to a neutral badge once a match has been in progress far longer than one can last", () => {
    const badge = resolveFixtureStatusBadge("IN_PROGRESS", KICKOFF_AT, minutesAfterKickoff(5 * 60));

    expect(badge).toEqual({ label: "In progress", className: "badge" });
    expect(badge?.className).not.toContain("badge-green");
  });

  it("leaves every other status as a flat lookup, unaffected by the clock", () => {
    const longAfterKickoff = minutesAfterKickoff(5 * 60);

    expect(resolveFixtureStatusBadge("SCHEDULED", KICKOFF_AT, longAfterKickoff)).toBeNull();
    expect(resolveFixtureStatusBadge("COMPLETED", KICKOFF_AT, longAfterKickoff)).toEqual({
      label: "Full time",
      className: "badge",
    });
    expect(resolveFixtureStatusBadge("POSTPONED", KICKOFF_AT, longAfterKickoff)?.label).toBe("Postponed");
    expect(resolveFixtureStatusBadge("INTERRUPTED", KICKOFF_AT, longAfterKickoff)?.label).toBe("Interrupted");
  });
});
