"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredToken } from "@/app/lib/auth";
import type { PlayerProfile, PlayerSeasonStatistics, PlayerWithStats } from "../../domain";

interface PlayerDetailResponse extends PlayerWithStats {
  profile: PlayerProfile | null;
  seasonStatistics: PlayerSeasonStatistics | null;
}

function describeRecentForm(player: PlayerWithStats): string {
  if (!player.recentFormPoints) return "Insufficient Data";
  return player.recentFormPoints.join(", ");
}

/** Client component (was a server component) so the gated GET /players/:id can carry the stored
 * session token via authedFetch — server components can't read the localStorage token.
 * The player is addressed by a ?playerId= query param rather than a path segment because the
 * frontend deploys as a static export (see "Deployment (AWS)" in the architecture doc) — runtime
 * UUIDs can't be enumerated as static paths at build time. The Suspense boundary is required for
 * useSearchParams under static prerendering. */
export default function PlayerDetailPage() {
  return (
    <Suspense fallback={null}>
      <PlayerDetailPageContent />
    </Suspense>
  );
}

function PlayerDetailPageContent() {
  const playerId = useSearchParams().get("playerId") ?? "";
  const router = useRouter();
  const [player, setPlayer] = useState<PlayerDetailResponse | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!getStoredToken()) {
      router.push("/login");
      return;
    }
    if (!playerId) {
      setNotFound(true);
      return;
    }

    authedFetch(`${getApiBaseUrl()}/players/${playerId}`)
      .then((response) => {
        if (!response.ok) {
          setNotFound(true);
          return null;
        }
        return response.json();
      })
      .then((result: PlayerDetailResponse | null) => {
        if (result) setPlayer(result);
      })
      .catch(() => setNotFound(true));
  }, [playerId, router]);

  if (notFound) {
    return (
      <main>
        <h1>Player not found</h1>
      </main>
    );
  }

  if (!player) {
    return (
      <main>
        <p>Loading player…</p>
      </main>
    );
  }

  const { profile, seasonStatistics } = player;

  return (
    <main>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
        {profile?.photoUrl && (
          <img
            src={profile.photoUrl}
            alt={player.name}
            width={72}
            height={72}
            style={{ borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)" }}
          />
        )}
        <div>
          <h1 style={{ marginBottom: "0.15rem" }}>{player.name}</h1>
          <p style={{ margin: 0, fontSize: "0.95rem" }}>
            {player.club} &middot; {player.position}
          </p>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat-tile">
          <span className="stat-tile-label">Price</span>
          <span className="stat-tile-value">£{player.priceInMillions}m</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Total Points</span>
          <span className="stat-tile-value">{player.totalFantasyPoints}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Recent Form</span>
          <span className="stat-tile-value" style={{ fontSize: "0.85rem" }}>{describeRecentForm(player)}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Availability</span>
          <span className="stat-tile-value" style={{ fontSize: "0.85rem" }}>
            {player.availabilityStatus}
            {player.availabilityReason ? ` (${player.availabilityReason})` : ""}
          </span>
        </div>
      </div>

      <h2>Profile</h2>
      {profile ? (
        <div className="card" style={{ maxWidth: 480 }}>
          <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "0.4rem 1.25rem", margin: 0 }}>
            <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Full name</dt>
            <dd style={{ margin: 0, fontSize: "0.9rem" }}>{profile.firstName} {profile.lastName}</dd>
            {profile.age != null && (
              <>
                <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Age</dt>
                <dd style={{ margin: 0, fontSize: "0.9rem" }}>{profile.age}</dd>
              </>
            )}
            {profile.nationality && (
              <>
                <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Nationality</dt>
                <dd style={{ margin: 0, fontSize: "0.9rem" }}>{profile.nationality}</dd>
              </>
            )}
            {profile.birthDate && (
              <>
                <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Born</dt>
                <dd style={{ margin: 0, fontSize: "0.9rem" }}>
                  {profile.birthDate}
                  {profile.birthPlace ? `, ${profile.birthPlace}` : ""}
                  {profile.birthCountry ? `, ${profile.birthCountry}` : ""}
                </dd>
              </>
            )}
            {profile.heightCm != null && (
              <>
                <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Height</dt>
                <dd style={{ margin: 0, fontSize: "0.9rem" }}>{profile.heightCm} cm</dd>
              </>
            )}
            {profile.weightKg != null && (
              <>
                <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Weight</dt>
                <dd style={{ margin: 0, fontSize: "0.9rem" }}>{profile.weightKg} kg</dd>
              </>
            )}
            {profile.shirtNumber != null && (
              <>
                <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Shirt</dt>
                <dd style={{ margin: 0, fontSize: "0.9rem" }}>#{profile.shirtNumber}</dd>
              </>
            )}
          </dl>
        </div>
      ) : (
        <p>Profile data is unavailable for this player.</p>
      )}

      <h2>Season Statistics</h2>
      {seasonStatistics ? (
        <div className="card" style={{ maxWidth: 480 }}>
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem" }}>
            {seasonStatistics.club} &middot; {seasonStatistics.leagueName} &middot; {seasonStatistics.season}
          </p>
          <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "0.4rem 1.25rem", margin: 0 }}>
            <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Appearances</dt>
            <dd style={{ margin: 0, fontSize: "0.9rem" }}>{seasonStatistics.appearances}</dd>
            <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Minutes</dt>
            <dd style={{ margin: 0, fontSize: "0.9rem" }}>{seasonStatistics.minutesPlayed}</dd>
            {seasonStatistics.rating != null && (
              <>
                <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Rating</dt>
                <dd style={{ margin: 0, fontSize: "0.9rem" }}>{seasonStatistics.rating.toFixed(2)}</dd>
              </>
            )}
            <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Goals</dt>
            <dd style={{ margin: 0, fontSize: "0.9rem" }}>{seasonStatistics.goals}</dd>
            <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Assists</dt>
            <dd style={{ margin: 0, fontSize: "0.9rem" }}>{seasonStatistics.assists}</dd>
            {seasonStatistics.position === "GK" && (
              <>
                <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Saves</dt>
                <dd style={{ margin: 0, fontSize: "0.9rem" }}>{seasonStatistics.saves}</dd>
              </>
            )}
            <dt style={{ color: "var(--color-text-muted)", fontSize: "0.85rem" }}>Cards</dt>
            <dd style={{ margin: 0, fontSize: "0.9rem" }}>
              {seasonStatistics.yellowCards} yellow, {seasonStatistics.redCards} red
            </dd>
          </dl>
        </div>
      ) : (
        <p>Season statistics are unavailable for this player.</p>
      )}
    </main>
  );
}
