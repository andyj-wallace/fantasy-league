"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LoadingState } from "@/app/components/LoadingState";
import { PlayerDetailPanel } from "@/app/components/PlayerDetailPanel";
import { useRequireAuth } from "@/app/lib/useRequireAuth";

/** Standalone player page — kept as a thin wrapper around the shared PlayerDetailPanel so deep
 * links and pre-hub navigation still resolve. The league hub renders the same panel inside a popup
 * overlay instead of sending the user here. The player is addressed by a ?playerId= query param
 * because the frontend deploys as a static export — runtime UUIDs can't be enumerated as static
 * paths at build time. The Suspense boundary is required for useSearchParams under static
 * prerendering. */
export default function PlayerDetailPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading player…" />}>
      <PlayerDetailPageContent />
    </Suspense>
  );
}

function PlayerDetailPageContent() {
  useRequireAuth();
  const playerId = useSearchParams().get("playerId") ?? "";
  const router = useRouter();

  return (
    <main>
      <p style={{ marginBottom: "0.35rem" }}>
        <button className="btn-link" onClick={() => router.back()}>
          ← Back
        </button>
      </p>
      <PlayerDetailPanel playerId={playerId} />
    </main>
  );
}
