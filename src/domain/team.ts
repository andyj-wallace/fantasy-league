import type { StartingFormation } from "./shared";

/** One player's place in a Team's 16-man roster: which slot, and whether they're starting or benched. */
export interface TeamRosterSlot {
  playerId: string;
  isStarting: boolean;
}

/**
 * A single user's entry in a single league: their 16-man roster, starting formation,
 * and captaincy. There is intentionally no separate Squad entity (see CLAUDE.md).
 */
export interface Team {
  id: string;
  leagueId: string;
  userId: string;
  name: string;
  /** Null until the squad builder flow runs setTeamLineup — a Team exists from the moment a
   * manager joins a league, before they've chosen a formation or captaincy. */
  formation: StartingFormation | null;
  /** Exactly 16 entries: 11 with isStarting=true, 5 with isStarting=false. Empty until the squad builder flow runs setTeamRoster. */
  rosterSlots: TeamRosterSlot[];
  captainPlayerId: string | null;
  viceCaptainPlayerId: string | null;
  remainingBudgetInMillions: number;
  /** Free transfers carried forward, including postponed-match awards. Hard-capped at 8. */
  bankedFreeTransferCount: number;
  createdAt: Date;
  updatedAt: Date;
}
