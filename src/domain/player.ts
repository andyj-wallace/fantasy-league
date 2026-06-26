import type { PlayerPosition } from "./shared";

/** A real-world Premier League footballer available to be drafted into a Team. */
export interface Player {
  id: string;
  name: string;
  club: string;
  position: PlayerPosition;
  priceInMillions: number;
  createdAt: Date;
  updatedAt: Date;
}
