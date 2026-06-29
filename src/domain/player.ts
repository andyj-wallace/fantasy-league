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
  createdAt: Date;
  updatedAt: Date;
}
