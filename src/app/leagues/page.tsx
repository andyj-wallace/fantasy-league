"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { clearStoredSession, getStoredToken } from "@/app/lib/auth";
import { TeamLeagueLinks } from "@/app/components/TeamLeagueLinks";
import type { League, LeagueStanding } from "../../domain";

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
 * Standings live now — folded in here instead of a separate /leaderboard page.
 * The league is addressed by a ?leagueId= query param rather than a path segment because the
 * frontend deploys as a static export (see "Deployment (AWS)" in the architecture doc) — runtime
 * UUIDs can't be enumerated as static paths at build time. The Suspense boundary is required for
 * useSearchParams under static prerendering. */
export default function LeaguePage() {
  return (
    <Suspense fallback={null}>
      <LeaguePageContent />
    </Suspense>
  );
}

function LeaguePageContent() {
  const leagueId = useSearchParams().get("leagueId") ?? "";
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
      <div className="page-header">
        <h1>Fantasy League</h1>
        <button className="btn-danger" onClick={handleLogout}>Log out</button>
      </div>

      {error && <p className="msg msg-error">{error}</p>}
      {!error && !teamWithLeague && <p>Loading…</p>}

      {teamWithLeague && (
        <p style={{ marginBottom: "0.75rem" }}>
          <TeamLeagueLinks team={teamWithLeague.team} league={teamWithLeague.league} />
        </p>
      )}

      {teamWithLeague && (
        <div className="invite-row">
          <span>Invite code</span>
          <span className="invite-code">{teamWithLeague.league.inviteCode}</span>
          <button onClick={() => handleCopyInvite(teamWithLeague.league.inviteCode)}>
            {copyStatus === "copied" ? "Copied!" : "Copy link"}
          </button>
          {copyStatus === "error" && (
            <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
              Could not copy — copy the code manually.
            </span>
          )}
          <a
            href={`https://wa.me/?text=${encodeURIComponent(
              `Join my Fantasy League "${teamWithLeague.league.name}": ${getInviteUrl(teamWithLeague.league.inviteCode)}`,
            )}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Share via WhatsApp
          </a>
        </div>
      )}

      <h2>Standings</h2>
      {standings === null && <p>Loading…</p>}
      {standings !== null && standings.length === 0 && (
        <p>No standings yet — these appear once a gameweek's matches have been scored.</p>
      )}
      {standings !== null && standings.length > 0 && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Team</th>
                  <th>Manager</th>
                  <th>Points</th>
                  <th>Goals</th>
                  <th>Banked</th>
                  <th>Spent</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((standing) => (
                  <tr key={standing.id}>
                    <td>{standing.rank}</td>
                    <td>{standing.teamName}</td>
                    <td>{standing.managerName}</td>
                    <td style={{ fontWeight: 700 }}>{standing.totalPoints}</td>
                    <td>{standing.tiebreakerStats.goalsScoredBySelectedPlayers}</td>
                    <td>{standing.tiebreakerStats.bankedFreeTransferCount}</td>
                    <td>£{standing.tiebreakerStats.totalSpentInMillions}M</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {lastUpdatedAt && (
            <p style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
              Last updated {lastUpdatedAt.toLocaleString()}
            </p>
          )}
        </>
      )}

      <div className="link-list">
        <Link href="/leagues/create">Create League</Link>
        <Link href="/leagues/join">Join League</Link>
      </div>
    </main>
  );
}
