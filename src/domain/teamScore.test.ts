import { describe, expect, it } from "vitest";
import { resolveCaptainBonusPlayerId } from "./teamScore";
import type { PlayerGameweekPoints } from "./playerScore";

/**
 * The armband rule, tested at the one place both callers share. calculateTeamScores uses it to
 * decide whose points get doubled into TeamScore.totalPoints; the squad builder's gameweek summary
 * uses it to name the bonus. These cases mirror calculateTeamScores.test.ts's captaincy tests —
 * if the two ever disagree, the UI would be explaining a total the scorer didn't produce.
 */
function played(totalPoints: number): PlayerGameweekPoints {
  return { totalPoints, didAppear: true };
}

/** A scored row for someone who never took the field — an unused sub, reported with 0 minutes. */
function didNotPlay(totalPoints = 0): PlayerGameweekPoints {
  return { totalPoints, didAppear: false };
}

describe("resolveCaptainBonusPlayerId", () => {
  it("gives the bonus to the captain when the captain played", () => {
    expect(
      resolveCaptainBonusPlayerId(
        { playerId: "cap", gameweekPoints: played(10) },
        { playerId: "vice", gameweekPoints: played(4) },
      ),
    ).toBe("cap");
  });

  it("falls back to the vice-captain when the captain has no scored match", () => {
    expect(
      resolveCaptainBonusPlayerId(
        { playerId: "cap", gameweekPoints: null },
        { playerId: "vice", gameweekPoints: played(4) },
      ),
    ).toBe("vice");
  });

  it("falls back to the vice-captain when the captain was an unused substitute", () => {
    expect(
      resolveCaptainBonusPlayerId(
        { playerId: "cap", gameweekPoints: didNotPlay() },
        { playerId: "vice", gameweekPoints: played(4) },
      ),
    ).toBe("vice");
  });

  it("still gives the captain the bonus when they played but scored nothing", () => {
    // A blank is not an absence: a captain who played and scored 0 keeps the armband, and doubling
    // 0 is correctly worth nothing. Handing it to the vice here would overpay the team.
    expect(
      resolveCaptainBonusPlayerId(
        { playerId: "cap", gameweekPoints: played(0) },
        { playerId: "vice", gameweekPoints: played(4) },
      ),
    ).toBe("cap");
  });

  it("awards no bonus when neither captain nor vice played", () => {
    expect(
      resolveCaptainBonusPlayerId(
        { playerId: "cap", gameweekPoints: null },
        { playerId: "vice", gameweekPoints: didNotPlay() },
      ),
    ).toBeNull();
  });

  it("awards no bonus when no captaincy has been set", () => {
    expect(
      resolveCaptainBonusPlayerId(
        { playerId: null, gameweekPoints: null },
        { playerId: null, gameweekPoints: null },
      ),
    ).toBeNull();
  });

  it("uses the vice-captain when no captain is set but the vice played", () => {
    expect(
      resolveCaptainBonusPlayerId(
        { playerId: null, gameweekPoints: null },
        { playerId: "vice", gameweekPoints: played(7) },
      ),
    ).toBe("vice");
  });
});
