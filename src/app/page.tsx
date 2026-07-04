"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredToken } from "@/app/lib/auth";
import { TeamLeagueLinks } from "@/app/components/TeamLeagueLinks";
import { LoadingState } from "@/app/components/LoadingState";
import type { League } from "../domain";

interface TeamSummary {
  id: string;
  name: string;
  remainingBudgetInMillions: number;
}

interface TeamWithLeague {
  team: TeamSummary;
  league: League;
  rosterCount: number;
  isLineupSet: boolean;
}

export default function HomePage() {
  const router = useRouter();
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
  const [teamsWithLeagues, setTeamsWithLeagues] = useState<TeamWithLeague[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = getStoredToken();
    setIsLoggedIn(token !== null);
    if (!token) return;

    authedFetch(`${getApiBaseUrl()}/me/teams`)
      .then((response) => response.json())
      .then((result: TeamWithLeague[]) => {
        if (result.length === 1) {
          router.push(`/leagues?leagueId=${result[0]!.league.id}`);
          return;
        }
        setTeamsWithLeagues(result);
      })
      .catch(() => setError("Could not load your leagues — try refreshing."));
  }, [router]);

  if (isLoggedIn === null) return <LoadingState />;

  if (!isLoggedIn) {
    return (
      <main>
        <h1>Fantasy League</h1>
        <p>
          <Link href="/login">Log in</Link> to see your leagues, or create/join one once you do.
        </p>
      </main>
    );
  }

  if (!error && teamsWithLeagues === null) return <LoadingState label="Loading your leagues…" />;

  return (
    <main>
      <h1>Your leagues</h1>
      {error && <p className="msg msg-error">{error}</p>}
      {!error && teamsWithLeagues!.length === 0 && (
        <p>You haven't joined or created a league yet.</p>
      )}
      {!error && teamsWithLeagues!.length > 0 && (
        <ul className="league-list">
          {teamsWithLeagues!.map(({ team, league, rosterCount, isLineupSet }) => (
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
