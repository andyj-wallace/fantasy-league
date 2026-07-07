"use client";

import { createContext, useContext } from "react";

export interface PlayerDetailContextValue {
  openPlayer: (playerId: string) => void;
}

/** Lets any deeply-nested player name (pitch dots, bench cards, list rows) open a player's details
 * without threading an onClick through every intermediate component. When the league hub provides
 * this, taps open the details popup in-place; when it's absent (a standalone page), PlayerNameTapTarget
 * falls back to navigating to /players. */
export const PlayerDetailContext = createContext<PlayerDetailContextValue | null>(null);

export function usePlayerDetailOpener(): ((playerId: string) => void) | null {
  return useContext(PlayerDetailContext)?.openPlayer ?? null;
}
