"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LoadingState } from "@/app/components/LoadingState";
import { PlayerDetailPanel } from "@/app/components/PlayerDetailPanel";
import { StandaloneViewToggle } from "@/app/components/StandaloneViewToggle";
import { API_CACHE_TTL_MS, getCachedJson } from "@/app/lib/apiCache";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { useRequireAuth } from "@/app/lib/useRequireAuth";
import { useStandalonePageGate } from "@/app/lib/standalonePageGate";
import type { TeamWithLeague } from "@/app/lib/teamTypes";

/** Standalone player page — a thin wrapper around the shared PlayerDetailPanel, kept as a
 * deep-linkable fallback. The gate (useStandalonePageGate) decides whether to render here or hand
 * off to the league hub's player popup. The player is addressed by a ?playerId= query param because
 * the frontend deploys as a static export — runtime UUIDs can't be enumerated as static paths at
 * build time. The Suspense boundary is required for useSearchParams under static prerendering. */
export default function PlayerDetailPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading player…" />}>
      <PlayerDetailPageContent />
    </Suspense>
  );
}

/** Maps this standalone route to its hub equivalent — the player popup on the hub. Player details
 * aren't league-scoped, but the hub is, so this lands the popup on the user's first league. Returns
 * null (stay standalone) when the user isn't in any league to open the hub against. */
async function resolvePlayerHubUrl(playerId: string): Promise<string | null> {
  if (!playerId) return null;
  try {
    const teams = await getCachedJson<TeamWithLeague[]>(`${getApiBaseUrl()}/me/teams`, API_CACHE_TTL_MS.SHORT);
    const firstLeagueId = teams[0]?.league?.id;
    if (!firstLeagueId) return null;
    return `/leagues?leagueId=${firstLeagueId}&playerId=${playerId}`;
  } catch {
    return null;
  }
}

function PlayerDetailPageContent() {
  useRequireAuth();
  const playerId = useSearchParams().get("playerId") ?? "";
  const router = useRouter();

  const gateStatus = useStandalonePageGate(() => resolvePlayerHubUrl(playerId));

  async function openInHub() {
    const hubUrl = await resolvePlayerHubUrl(playerId);
    if (hubUrl) router.push(hubUrl);
  }

  if (gateStatus !== "render") return <LoadingState label="Opening…" />;

  return (
    <main>
      <p style={{ marginBottom: "0.35rem" }}>
        <button className="btn-link" onClick={() => router.back()}>
          ← Back
        </button>
      </p>
      <StandaloneViewToggle onOpenInHub={openInHub} />
      <PlayerDetailPanel playerId={playerId} />
    </main>
  );
}
