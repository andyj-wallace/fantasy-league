"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LoadingState } from "@/app/components/LoadingState";
import { TransfersPanel } from "@/app/components/TransfersPanel";
import { StandaloneViewToggle } from "@/app/components/StandaloneViewToggle";
import { fetchJson } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { useRequireAuth } from "@/app/lib/useRequireAuth";
import { useStandalonePageGate } from "@/app/lib/standalonePageGate";
import type { Team } from "../../../domain";

/** Standalone transfers page — a thin wrapper around the shared TransfersPanel, kept as a
 * deep-linkable fallback. The gate (useStandalonePageGate) decides whether to render here or hand
 * off to the league hub's transfers overlay. The team is addressed by a ?teamId= query param
 * because the frontend deploys as a static export — runtime UUIDs can't be enumerated as static
 * paths at build time. The Suspense boundary is required for useSearchParams under static
 * prerendering. */
export default function TransfersPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading your transfers…" />}>
      <TransfersPageContent />
    </Suspense>
  );
}

/** Maps this standalone route to its hub equivalent — the transfers overlay open on the team's
 * league page. Needs a fetch because the URL only carries teamId, while the hub is addressed by
 * leagueId. */
async function resolveTransfersHubUrl(teamId: string): Promise<string | null> {
  if (!teamId) return null;
  try {
    const team = await fetchJson<Team>(`${getApiBaseUrl()}/teams/${teamId}`);
    if (!team?.leagueId) return null;
    return `/leagues?leagueId=${team.leagueId}&panel=transfers&teamId=${teamId}`;
  } catch {
    return null;
  }
}

function TransfersPageContent() {
  useRequireAuth();
  const teamId = useSearchParams().get("teamId") ?? "";
  const router = useRouter();

  const gateStatus = useStandalonePageGate(() => resolveTransfersHubUrl(teamId));

  async function openInHub() {
    const hubUrl = await resolveTransfersHubUrl(teamId);
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
      <h1>Transfers</h1>
      <TransfersPanel teamId={teamId} onPlayerClick={(playerId) => router.push(`/players?playerId=${playerId}`)} />
    </main>
  );
}
