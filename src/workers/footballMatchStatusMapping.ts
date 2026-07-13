import type { MatchStatus } from "../domain";

/**
 * Maps API-Football's fixture status short codes onto our MatchStatus enum. PST (postponed) is
 * the only one of these expected to be rescheduled and eventually reach COMPLETED. CANC/ABD/AWD/WO
 * (cancelled/abandoned/awarded/walkover) map to VOIDED instead: none represent a normally-completed
 * result, but they're also terminal — the fixture will never be replayed, so VOIDED keeps them out
 * of the scoring engine (no PlayerMatchStat to import) while still letting their gameweek resolve.
 */
const STATUS_CODE_TO_MATCH_STATUS: Record<string, MatchStatus> = {
  NS: "SCHEDULED",
  TBD: "SCHEDULED",
  "1H": "IN_PROGRESS",
  HT: "IN_PROGRESS",
  "2H": "IN_PROGRESS",
  ET: "IN_PROGRESS",
  BT: "IN_PROGRESS",
  P: "IN_PROGRESS",
  SUSP: "INTERRUPTED",
  INT: "INTERRUPTED",
  FT: "COMPLETED",
  AET: "COMPLETED",
  PEN: "COMPLETED",
  PST: "POSTPONED",
  CANC: "VOIDED",
  ABD: "VOIDED",
  AWD: "VOIDED",
  WO: "VOIDED",
};

export function mapApiFootballStatusToMatchStatus(shortCode: string): MatchStatus {
  return STATUS_CODE_TO_MATCH_STATUS[shortCode] ?? "SCHEDULED";
}
