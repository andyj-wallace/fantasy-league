"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { API_CACHE_TTL_MS, getCachedJson } from "@/app/lib/apiCache";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredToken } from "@/app/lib/auth";
import { TeamLeagueLinks } from "@/app/components/TeamLeagueLinks";
import { LoadingState } from "@/app/components/LoadingState";
import { LoggedOutLanding } from "@/app/components/LoggedOutLanding";
import type { TeamWithLeague } from "@/app/lib/teamTypes";

type LeaguesStatus = "loading" | "ready" | "error";

export default function HomePage() {
  const router = useRouter();
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
  const [teamsWithLeagues, setTeamsWithLeagues] = useState<TeamWithLeague[]>([]);
  const [status, setStatus] = useState<LeaguesStatus>("loading");

  useEffect(() => {
    const token = getStoredToken();
    setIsLoggedIn(token !== null);
    if (!token) return;

    getCachedJson<TeamWithLeague[]>(`${getApiBaseUrl()}/me/teams`, API_CACHE_TTL_MS.SHORT)
      .then((result) => {
        // Only a genuine failure (network error, malformed body) is an error. A 200 with an
        // empty array means "you're in no leagues yet" — that's a friendly empty state, never an error.
        if (!Array.isArray(result)) throw new Error("GET /me/teams did not return a list");
        if (result.length === 1) {
          router.push(`/leagues?leagueId=${result[0]!.league.id}`);
          return; // stay in "loading" through the redirect so the list never flashes
        }
        setTeamsWithLeagues(result);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, [router]);

  if (isLoggedIn === null) return <LoadingState />;
  if (!isLoggedIn) return <LoggedOutLanding />;
  if (status === "loading") return <LoadingState label="Loading your leagues…" />;

  return (
    <main>
      <h1>Your leagues</h1>

      {status === "error" && (
        <p className="msg msg-info">
          We couldn&apos;t load your leagues just now — you can still create or join one below, or refresh to try again.
        </p>
      )}

      {status === "ready" && teamsWithLeagues.length === 0 && (
        <div className="empty-state">
          <p className="empty-state-title">No leagues currently</p>
          <p>Create your own league and invite friends, or join one with an invite code.</p>
        </div>
      )}

      {status === "ready" && teamsWithLeagues.length > 0 && (
        <ul className="league-list">
          {teamsWithLeagues.map(({ team, league, rosterCount, isLineupSet }) => (
            <li key={team.id}>
              <TeamLeagueLinks team={team} league={league} rosterCount={rosterCount} isLineupSet={isLineupSet} />
            </li>
          ))}
        </ul>
      )}

      <div className="link-list">
        <Link href="/leagues/create">Create League</Link>
        <Link href="/leagues/join">Join League</Link>
      </div>
    </main>
  );
}
