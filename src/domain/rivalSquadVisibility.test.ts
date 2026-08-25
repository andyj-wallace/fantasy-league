import { describe, expect, it } from "vitest";
import { resolveRivalSquadVisibility } from "./rivalSquadVisibility";

const DEADLINE = new Date("2026-08-25T11:30:00Z");

describe("resolveRivalSquadVisibility", () => {
  it("hides before the deadline and reports when it reveals", () => {
    const result = resolveRivalSquadVisibility({
      currentGameweek: { status: "UPCOMING", deadlineAt: DEADLINE },
      hasCompletedGameweek: false,
      now: new Date("2026-08-25T11:00:00Z"),
    });

    expect(result).toEqual({ isSquadVisible: false, revealsAt: DEADLINE });
  });

  it("reveals exactly at the deadline", () => {
    const result = resolveRivalSquadVisibility({
      currentGameweek: { status: "UPCOMING", deadlineAt: DEADLINE },
      hasCompletedGameweek: false,
      now: DEADLINE,
    });

    expect(result).toEqual({ isSquadVisible: true, revealsAt: null });
  });

  it.each(["LOCKED", "IN_PROGRESS", "COMPLETED"] as const)(
    "reveals for %s status even before the clock reaches the deadline",
    (status) => {
      const result = resolveRivalSquadVisibility({
        currentGameweek: { status, deadlineAt: DEADLINE },
        hasCompletedGameweek: false,
        now: new Date("2026-08-25T11:00:00Z"),
      });

      expect(result).toEqual({ isSquadVisible: true, revealsAt: null });
    },
  );

  it("hides when there is no gameweek and none has completed (preseason)", () => {
    const result = resolveRivalSquadVisibility({
      currentGameweek: null,
      hasCompletedGameweek: false,
      now: new Date("2026-08-25T11:00:00Z"),
    });

    expect(result).toEqual({ isSquadVisible: false, revealsAt: null });
  });

  it("reveals when there is no current gameweek but one has completed (season over)", () => {
    const result = resolveRivalSquadVisibility({
      currentGameweek: null,
      hasCompletedGameweek: true,
      now: new Date("2026-08-25T11:00:00Z"),
    });

    expect(result).toEqual({ isSquadVisible: true, revealsAt: null });
  });
});
