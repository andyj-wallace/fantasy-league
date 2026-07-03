"use client";

import { useRouter } from "next/navigation";
import type { KeyboardEvent } from "react";

/** Plain-text, non-button/non-link tap target that navigates to a player's detail page.
 * Used where a player's name should stay visually plain (no underline/link color) but still
 * be reachable — currently the Squad Builder's Starting XI and Bench lists. */
export function PlayerNameTapTarget({ playerId, playerName }: { playerId: string; playerName: string }) {
  const router = useRouter();

  function navigateToPlayer() {
    router.push(`/players?playerId=${playerId}`);
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
