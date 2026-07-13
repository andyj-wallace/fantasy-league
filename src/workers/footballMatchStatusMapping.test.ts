import { describe, expect, it } from "vitest";
import { mapApiFootballStatusToMatchStatus } from "./footballMatchStatusMapping";

describe("mapApiFootballStatusToMatchStatus", () => {
  it("maps PST to POSTPONED — expected to be rescheduled and eventually reach COMPLETED", () => {
    expect(mapApiFootballStatusToMatchStatus("PST")).toBe("POSTPONED");
  });

  it.each(["CANC", "ABD", "AWD", "WO"])(
    "maps %s to VOIDED — a terminal state that will never reach COMPLETED",
    (shortCode) => {
      expect(mapApiFootballStatusToMatchStatus(shortCode)).toBe("VOIDED");
    },
  );

  it("maps FT/AET/PEN to COMPLETED", () => {
    expect(mapApiFootballStatusToMatchStatus("FT")).toBe("COMPLETED");
    expect(mapApiFootballStatusToMatchStatus("AET")).toBe("COMPLETED");
    expect(mapApiFootballStatusToMatchStatus("PEN")).toBe("COMPLETED");
  });

  it("defaults an unrecognized code to SCHEDULED", () => {
    expect(mapApiFootballStatusToMatchStatus("SOME_UNKNOWN_CODE")).toBe("SCHEDULED");
  });
});
