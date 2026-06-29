"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { clearStoredSession, getStoredToken } from "@/app/lib/auth";
import { TeamLeagueLinks } from "@/app/components/TeamLeagueLinks";
import type { League } from "../domain";

interface TeamSummary {
  id: string;
  name: string;
  remainingBudgetInMillions: number;
}

interface TeamWithLeague {
  team: TeamSummary;
  league: League;
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
          router.push(`/leagues/${result[0]!.league.id}`);
          return;
        }
        setTeamsWithLeagues(result);
      })
      .catch(() => setError("Could not load your leagues — try refreshing."));
  }, [router]);

  function handleLogout() {
    clearStoredSession();
    setIsLoggedIn(false);
    setTeamsWithLeagues(null);
  }

  if (isLoggedIn === null) return null; // avoid a logged-out flash while localStorage is checked

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

  // teamsWithLeagues stays null while loading, and while a single-league redirect is in flight.
  if (!error && teamsWithLeagues === null) return null;

  return (
    <main>
      <h1>Fantasy League</h1>
      <button onClick={handleLogout}>Log out</button>

      <h2>Your leagues</h2>
      {error && <p>{error}</p>}
      {!error && teamsWithLeagues!.length === 0 && <p>You haven't joined or created a league yet.</p>}
      {!error && teamsWithLeagues!.length > 0 && (
        <ul>
          {teamsWithLeagues!.map(({ team, league }) => (
            <li key={team.id}>
              <TeamLeagueLinks team={team} league={league} />
            </li>
          ))}
        </ul>
      )}

      <ul>
        <li>
          <Link href="/leagues/create">Create League</Link>
        </li>
        <li>
          <Link href="/leagues/join">Join League</Link>
        </li>
      </ul>
    </main>
  );
}
