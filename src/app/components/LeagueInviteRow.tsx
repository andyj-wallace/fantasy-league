"use client";

import { useState } from "react";
import type { League } from "../../domain";

function getInviteUrl(inviteCode: string): string {
  return `${window.location.origin}/leagues/join?code=${inviteCode}`;
}

/** The invite row on the league page: the raw invite code, a copy-link button (with a clipboard
 * failure fallback), and a WhatsApp share deep link. Owns its own transient copy status so the
 * league page doesn't have to thread it through. */
export function LeagueInviteRow({ league }: { league: League }) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

  async function handleCopyInvite() {
    try {
      await navigator.clipboard.writeText(getInviteUrl(league.inviteCode));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
    setTimeout(() => setCopyStatus("idle"), 2000);
  }

  return (
    <div className="invite-row">
      <span>Invite code</span>
      <span className="invite-code">{league.inviteCode}</span>
      <button onClick={handleCopyInvite}>{copyStatus === "copied" ? "Copied!" : "Copy link"}</button>
      {copyStatus === "error" && (
        <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
          Could not copy — copy the code manually.
        </span>
      )}
      <a
        href={`https://wa.me/?text=${encodeURIComponent(
          `Join my Fantasy League "${league.name}": ${getInviteUrl(league.inviteCode)}`,
        )}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Share via WhatsApp
      </a>
    </div>
  );
}
