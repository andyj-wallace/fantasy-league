"use client";

import { useEffect, useState, type ReactNode } from "react";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { LoadingState } from "@/app/components/LoadingState";
import { RecentFormBars } from "@/app/components/RecentFormBars";
import { StatTile } from "@/app/components/StatTile";
import type { PlayerProfile, PlayerSeasonStatistics, PlayerWithStats } from "../../domain";

interface PlayerDetailResponse extends PlayerWithStats {
  profile: PlayerProfile | null;
  seasonStatistics: PlayerSeasonStatistics | null;
}

/** One label/value pair in a `.detail-list`, skipped entirely when the value is absent — collapses
 * the repetitive, inline-styled dt/dd markup the profile and season-stat cards used to spell out by
 * hand. A `0` counts as present (goals/assists/appearances should still show a zero). */
function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/** A player's profile, form, and season stats as pure content (no page chrome), so the same view
 * can render inside the league hub's popup overlay or as the standalone /players page. Fetches its
 * own data from GET /players/:id; owns its loading and not-found states. */
export function PlayerDetailPanel({ playerId }: { playerId: string }) {
  const [player, setPlayer] = useState<PlayerDetailResponse | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!playerId) {
      setNotFound(true);
      return;
    }
    setPlayer(null);
    setNotFound(false);
    let cancelled = false;
    authedFetch(`${getApiBaseUrl()}/players/${playerId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((result: PlayerDetailResponse | null) => {
        if (cancelled) return;
        if (result) setPlayer(result);
        else setNotFound(true);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  if (notFound) return <p>This player could not be found.</p>;
  if (!player) return <LoadingState label="Loading player…" />;

  const { profile, seasonStatistics } = player;

  return (
    <>
      <div className="player-detail-head">
        {profile?.photoUrl && (
          <img src={profile.photoUrl} alt={player.name} width={72} height={72} className="player-detail-photo" />
        )}
        <div>
          <h3 className="player-detail-name">{player.name}</h3>
          <p className="player-detail-meta">
            {player.club} &middot; {player.position}
          </p>
        </div>
      </div>

      <div className="stat-row">
        <StatTile label="Price" value={`£${player.priceInMillions}m`} />
        <StatTile label="Total Points" value={player.totalFantasyPoints} />
        <StatTile label="Recent Form" value={<RecentFormBars points={player.recentFormPoints} />} />
        <StatTile
          label="Availability"
          valueStyle={{ fontSize: "0.85rem" }}
          value={`${player.availabilityStatus}${player.availabilityReason ? ` (${player.availabilityReason})` : ""}`}
        />
      </div>

      <h4>Profile</h4>
      {profile ? (
        <div className="card">
          <dl className="detail-list">
            <DetailRow label="Full name" value={`${profile.firstName} ${profile.lastName}`} />
            <DetailRow label="Age" value={profile.age} />
            <DetailRow label="Nationality" value={profile.nationality} />
            <DetailRow
              label="Born"
              value={
                profile.birthDate
                  ? `${profile.birthDate}${profile.birthPlace ? `, ${profile.birthPlace}` : ""}${
                      profile.birthCountry ? `, ${profile.birthCountry}` : ""
                    }`
                  : null
              }
            />
            <DetailRow label="Height" value={profile.heightCm != null ? `${profile.heightCm} cm` : null} />
            <DetailRow label="Weight" value={profile.weightKg != null ? `${profile.weightKg} kg` : null} />
            <DetailRow label="Shirt" value={profile.shirtNumber != null ? `#${profile.shirtNumber}` : null} />
          </dl>
        </div>
      ) : (
        <p>Profile data is unavailable for this player.</p>
      )}

      <h4>Season Statistics</h4>
      {seasonStatistics ? (
        <div className="card">
          <p className="player-detail-meta" style={{ marginBottom: "0.75rem" }}>
            {seasonStatistics.club} &middot; {seasonStatistics.leagueName} &middot; {seasonStatistics.season}
          </p>
          <dl className="detail-list">
            <DetailRow label="Appearances" value={seasonStatistics.appearances} />
            <DetailRow label="Minutes" value={seasonStatistics.minutesPlayed} />
            <DetailRow label="Rating" value={seasonStatistics.rating != null ? seasonStatistics.rating.toFixed(2) : null} />
            <DetailRow label="Goals" value={seasonStatistics.goals} />
            <DetailRow label="Assists" value={seasonStatistics.assists} />
            {seasonStatistics.position === "GK" && <DetailRow label="Saves" value={seasonStatistics.saves} />}
            <DetailRow label="Cards" value={`${seasonStatistics.yellowCards} yellow, ${seasonStatistics.redCards} red`} />
          </dl>
        </div>
      ) : (
        <p>Season statistics are unavailable for this player.</p>
      )}
    </>
  );
}
