"use client";

import { useRouter } from "next/navigation";
import type { KeyboardEvent } from "react";
import { usePlayerDetailOpener } from "@/app/lib/playerDetailContext";

/** Plain-text, non-button/non-link tap target that opens a player's details.
 * Used where a player's name should stay visually plain (no underline/link color) but still
 * be reachable — the Squad Builder's Starting XI, Bench, and pitch. Inside the league hub it opens
 * the details popup in-place (via PlayerDetailContext); otherwise it navigates to /players. */
export function PlayerNameTapTarget({ playerId, playerName }: { playerId: string; playerName: string }) {
  const router = useRouter();
  const openPlayerInHub = usePlayerDetailOpener();

  function navigateToPlayer() {
    if (openPlayerInHub) openPlayerInHub(playerId);
    else router.push(`/players?playerId=${playerId}`);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      navigateToPlayer();
    }
  }

  return (
    <span
      role="link"
      tabIndex={0}
      onClick={navigateToPlayer}
      onKeyDown={handleKeyDown}
      className="player-tap-target"
    >
      {playerName}
    </span>
  );
}
