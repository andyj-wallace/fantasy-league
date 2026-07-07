"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LoadingState } from "@/app/components/LoadingState";
import { TransfersPanel } from "@/app/components/TransfersPanel";
import { useRequireAuth } from "@/app/lib/useRequireAuth";

/** Standalone transfers page — kept as a thin wrapper around the shared TransfersPanel so deep
 * links and pre-hub navigation still resolve. The league hub renders the same panel inside a
 * slide-up overlay instead of sending the user here. The team is addressed by a ?teamId= query
 * param because the frontend deploys as a static export — runtime UUIDs can't be enumerated as
 * static paths at build time. The Suspense boundary is required for useSearchParams under static
 * prerendering. */
export default function TransfersPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading your transfers…" />}>
      <TransfersPageContent />
    </Suspense>
  );
}

function TransfersPageContent() {
  useRequireAuth();
  const teamId = useSearchParams().get("teamId") ?? "";
  const router = useRouter();

  return (
    <main>
      <p style={{ marginBottom: "0.35rem" }}>
        <button className="btn-link" onClick={() => router.back()}>
          ← Back
        </button>
      </p>
      <h1>Transfers</h1>
      <TransfersPanel teamId={teamId} onPlayerClick={(playerId) => router.push(`/players?playerId=${playerId}`)} />
    </main>
  );
}
