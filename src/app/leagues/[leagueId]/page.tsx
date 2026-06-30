"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { clearStoredSession, getStoredToken } from "@/app/lib/auth";
import { TeamLeagueLinks } from "@/app/components/TeamLeagueLinks";
import type { League, LeagueStanding } from "../../../domain";

interface TeamSummary {
  id: string;
  name: string;
  remainingBudgetInMillions: number;
}

interface TeamWithLeague {
  team: TeamSummary;
  league: League;
}

interface StandingEntry extends LeagueStanding {
  teamName: string;
  managerName: string;
}

/** Landing page for a user who's in exactly one league — home redirects here instead of
 * showing a one-item list. Refetches /me/teams rather than adding a single-league API,
 * since that endpoint already returns everything this page needs. Also where a league's
 * Standings live now — folded in here instead of a separate /leaderboard page. */
export default function LeaguePage() {
  const { leagueId } = useParams<{ leagueId: string }>();
  const router = useRouter();
  const [teamWithLeague, setTeamWithLeague] = useState<TeamWithLeague | null>(null);
  const [standings, setStandings] = useState<StandingEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    if (!getStoredToken()) {
      router.push("/login");
      return;
    }

    authedFetch(`${getApiBaseUrl()}/me/teams`)
      .then((response) => response.json())
      .then((result: TeamWithLeague[]) => {
        const match = result.find(({ league }) => league.id === leagueId);
        if (!match) {
          setError("You're not part of this league.");
          return;
        }
        setTeamWithLeague(match);
      })
      .catch(() => setError("Could not load this league — try refreshing."));

    authedFetch(`${getApiBaseUrl()}/leagues/${leagueId}/standings`)
      .then((response) => response.json())
      .then(setStandings)
      .catch(() => setError("Could not load this league's standings — try refreshing."));
  }, [leagueId, router]);

  function handleLogout() {
    clearStoredSession();
    router.push("/");
  }

  function getInviteUrl(inviteCode: string): string {
    return `${window.location.origin}/leagues/join?code=${inviteCode}`;
  }

  async function handleCopyInvite(inviteCode: string) {
    try {
      await navigator.clipboard.writeText(getInviteUrl(inviteCode));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
    setTimeout(() => setCopyStatus("idle"), 2000);
  }

  const lastUpdatedAt =
    standings && standings.length > 0
      ? new Date(Math.max(...standings.map((standing) => new Date(standing.calculatedAt).getTime())))
      : null;

  return (
    <main>
      <h1>Fantasy League</h1>
      <button onClick={handleLogout}>Log out</button>

      {error && <p>{error}</p>}
      {!error && !teamWithLeague && <p>Loading...</p>}
      {teamWithLeague && (
        <p>
          <TeamLeagueLinks team={teamWithLeague.team} league={teamWithLeague.league} />
        </p>
      )}

      {teamWithLeague && (
        <p>
          Invite code: <strong>{teamWithLeague.league.inviteCode}</strong>{" "}
          <button onClick={() => handleCopyInvite(teamWithLeague.league.inviteCode)}>Copy invite link</button>
          {copyStatus === "copied" && " Copied!"}
          {copyStatus === "error" && " Could not copy — copy the code manually."}{" "}
          <a
            href={`https://wa.me/?text=${encodeURIComponent(
              `Join my Fantasy League "${teamWithLeague.league.name}": ${getInviteUrl(teamWithLeague.league.inviteCode)}`,
            )}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Share via WhatsApp
          </a>
        </p>
      )}

      <h2>Standings</h2>
      {standings === null && <p>Loading...</p>}
      {standings !== null && standings.length === 0 && (
        <p>No standings yet — these appear once a gameweek's matches have been scored.</p>
      )}
      {standings !== null && standings.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Team</th>
                <th>Manager</th>
                <th>Points</th>
                <th>Goal Total</th>
                <th>Banked Transfers</th>
                <th>Season Expenditure</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((standing) => (
                <tr key={standing.id}>
                  <td>{standing.rank}</td>
                  <td>{standing.teamName}</td>
                  <td>{standing.managerName}</td>
                  <td>{standing.totalPoints}</td>
                  <td>{standing.tiebreakerStats.goalsScoredBySelectedPlayers}</td>
                  <td>{standing.tiebreakerStats.bankedFreeTransferCount}</td>
                  <td>£{standing.tiebreakerStats.totalSpentInMillions}M</td>
                </tr>
              ))}
            </tbody>
          </table>
          {lastUpdatedAt && <p>Last updated: {lastUpdatedAt.toLocaleString()}</p>}
        </>
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
