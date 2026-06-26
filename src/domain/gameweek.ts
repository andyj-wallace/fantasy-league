import type { GameweekStatus } from "./shared";

/** One numbered round of the season; the unit free transfers, scoring, and standings accrue per. */
export interface Gameweek {
  id: string;
  number: number;
  /** When lineups/transfers for this gameweek stop being editable league-wide (individual players still lock at their own kickoff). */
  deadlineAt: Date;
  status: GameweekStatus;
}
