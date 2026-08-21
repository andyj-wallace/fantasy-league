import type { PlayerAvailabilityStatus, PlayerPosition } from "./shared";

/** A real-world Premier League footballer available to be drafted into a Team. */
export interface Player {
  id: string;
  /** The football data provider's ID for this player; null until the roster importer links it. */
  externalId: string | null;
  name: string;
  club: string;
  position: PlayerPosition;
  priceInMillions: number;
  availabilityStatus: PlayerAvailabilityStatus;
  /** Raw provider text ("Knee Injury", "Suspended", ...) for tooltip/label display alongside availabilityStatus. */
  availabilityReason: string | null;
  /** False once a roster import no longer finds this player in a current Premier League squad —
   * a relegated club's player, or one transferred out of the league. Kept in the table (historic
   * score rows reference it) but hidden from player discovery. */
  isInCurrentSeasonSquad: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A Player enriched with scoring history for squad-builder/player-detail display — derived on
 * read from PlayerScore rows, never persisted itself. */
export interface PlayerWithStats extends Player {
  totalFantasyPoints: number;
  /** Most-recent-first points from up to the last 5 scored matches; null if fewer than 3 ("Insufficient Data"). */
  recentFormPoints: number[] | null;
}
