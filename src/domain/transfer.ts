/** A single player-out/player-in swap made to a Team in a given gameweek. */
export interface Transfer {
  id: string;
  teamId: string;
  gameweekId: string;
  playerOutId: string;
  playerInId: string;
  /** 0 if covered by a banked free transfer (regular or postponed-match-awarded), 10 otherwise. */
  pointsCost: number;
  createdAt: Date;
}
