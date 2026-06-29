import type { MatchStatus } from "../domain";

/**
 * Maps API-Football's fixture status short codes onto our MatchStatus enum. PST/CANC/ABD/AWD/WO
 * all collapse to POSTPONED: none represent a normally-completed result, and V1's MatchStatus
 * has no separate "abandoned/awarded" terminal state — POSTPONED is the closest fit, and keeps
 * these fixtures out of the scoring engine until manually resolved.
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
  CANC: "POSTPONED",
  ABD: "POSTPONED",
  AWD: "POSTPONED",
  WO: "POSTPONED",
};

export function mapApiFootballStatusToMatchStatus(shortCode: string): MatchStatus {
  return STATUS_CODE_TO_MATCH_STATUS[shortCode] ?? "SCHEDULED";
}
