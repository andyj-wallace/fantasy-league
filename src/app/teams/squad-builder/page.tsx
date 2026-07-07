"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GameweekBanner } from "@/app/components/GameweekBanner";
import { LoadingState } from "@/app/components/LoadingState";
import { SquadBuilderPanel } from "@/app/components/SquadBuilderPanel";
import { StandaloneViewToggle } from "@/app/components/StandaloneViewToggle";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { useRequireAuth } from "@/app/lib/useRequireAuth";
import { useStandalonePageGate } from "@/app/lib/standalonePageGate";
import type { Team } from "../../../domain";

/** Standalone squad builder — a thin wrapper around the shared SquadBuilderPanel, kept as a
 * deep-linkable fallback. The gate (useStandalonePageGate) decides whether to render here or hand
 * off to the league hub's squad overlay. The team is addressed by a ?teamId= query param because
 * the frontend deploys as a static export — runtime UUIDs can't be enumerated as static paths at
 * build time. The Suspense boundary is required for useSearchParams under static prerendering. */
export default function SquadBuilderPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <SquadBuilderPageContent />
    </Suspense>
  );
}

/** Maps this standalone route to its hub equivalent — the squad overlay open on the team's league
 * page. Needs a fetch because the URL only carries teamId, while the hub is addressed by leagueId. */
async function resolveSquadHubUrl(teamId: string): Promise<string | null> {
  if (!teamId) return null;
  try {
    const team: Team = await authedFetch(`${getApiBaseUrl()}/teams/${teamId}`).then((response) => response.json());
    if (!team?.leagueId) return null;
    return `/leagues?leagueId=${team.leagueId}&panel=squad&teamId=${teamId}`;
  } catch {
    return null;
  }
}

function SquadBuilderPageContent() {
  useRequireAuth();
  const teamId = useSearchParams().get("teamId") ?? "";
  const router = useRouter();

  const gateStatus = useStandalonePageGate(() => resolveSquadHubUrl(teamId));

  async function openInHub() {
    const hubUrl = await resolveSquadHubUrl(teamId);
    if (hubUrl) router.push(hubUrl);
  }

  if (gateStatus !== "render") return <LoadingState label="Opening…" />;

  return (
    <main className="page-with-sidebar">
      <GameweekBanner />

      <div className="page-content" style={{ paddingBottom: "9rem" }}>
        <p style={{ marginBottom: "0.35rem" }}>
          <button className="btn-link" onClick={() => router.back()}>
            ← Back
          </button>
        </p>
        <StandaloneViewToggle onOpenInHub={openInHub} />
        <h1>Squad Builder</h1>
        <SquadBuilderPanel teamId={teamId} />
      </div>
    </main>
  );
}
