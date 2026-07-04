"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredToken } from "@/app/lib/auth";
import { TeamLeagueLinks } from "@/app/components/TeamLeagueLinks";
import { GameweekBanner } from "@/app/components/GameweekBanner";
import { LoadingState } from "@/app/components/LoadingState";
import { useCurrentGameweek, type GameweekMatchSummary } from "@/app/lib/useCurrentGameweek";
import { formatDayAndTime } from "@/app/lib/formatDate";
import type { GameweekStatus, League, LeagueStanding, MatchStatus } from "../../domain";

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

interface StandingEntry extends LeagueStanding {
  teamName: string;
  managerName: string;
}

interface StandingsResponse {
  gameweek: { number: number; status: GameweekStatus } | null;
  standings: StandingEntry[];
}

/** The specified tooltip copy for the standings timestamp — see fantasy_league_user_flows_v1.txt. */
const STANDINGS_UPDATE_TOOLTIP =
  "Scores update shortly after each match ends. On busier days with several matches finishing close together, it can take a bit longer for every score to come through.";

const fixtureStatusBadges: Record<MatchStatus, { label: string; className: string } | null> = {
  SCHEDULED: null,
  IN_PROGRESS: { label: "Live", className: "badge badge-green" },
  COMPLETED: { label: "Full time", className: "badge" },
  POSTPONED: { label: "Postponed", className: "badge badge-red" },
  DELAYED: { label: "Delayed", className: "badge badge-red" },
  INTERRUPTED: { label: "Interrupted", className: "badge badge-red" },
};

function FixtureRow({ match }: { match: GameweekMatchSummary }) {
  const statusBadge = fixtureStatusBadges[match.status];
  const hasFinalScore = match.finalHomeScore !== null && match.finalAwayScore !== null;
  return (
    <li>
      <span className="fixture-teams">
        {match.homeClub} v {match.awayClub}
      </span>
      {hasFinalScore && (
        <span className="fixture-score">
          {match.finalHomeScore}–{match.finalAwayScore}
        </span>
      )}
      {statusBadge && <span className={statusBadge.className}>{statusBadge.label}</span>}
      <span className="fixture-kickoff">{formatDayAndTime(match.kickoffAt)}</span>
    </li>
  );
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
    <Suspense fallback={<LoadingState />}>
      <LeaguePageContent />
    </Suspense>
  );
}

function LeaguePageContent() {
  const leagueId = useSearchParams().get("leagueId") ?? "";
  const router = useRouter();
  const [teamWithLeague, setTeamWithLeague] = useState<TeamWithLeague | null>(null);
  const [standingsResponse, setStandingsResponse] = useState<StandingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const currentGameweek = useCurrentGameweek();

  useEffect(() => {
    if (!getStoredToken()) {
      router.push("/login");
      return;
    }
    if (!leagueId) {
      setError("No league specified — open a league from your home page.");
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
      .then(setStandingsResponse)
      .catch(() => setError("Could not load this league's standings — try refreshing."));
  }, [leagueId, router]);

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

  const standings = standingsResponse?.standings ?? null;
  const standingsGameweek = standingsResponse?.gameweek ?? null;
  const lastUpdatedAt =
    standings && standings.length > 0
      ? new Date(Math.max(...standings.map((standing) => new Date(standing.calculatedAt).getTime())))
      : null;

  return (
    <main>
      <h1>{teamWithLeague?.league.name ?? "League"}</h1>

      <GameweekBanner current={currentGameweek} />

      {error && <p className="msg msg-error">{error}</p>}
      {!error && !teamWithLeague && <p aria-busy="true">Loading…</p>}

      {teamWithLeague && (
        <p style={{ marginBottom: "0.75rem" }}>
          <TeamLeagueLinks
            team={teamWithLeague.team}
            league={teamWithLeague.league}
            rosterCount={teamWithLeague.rosterCount}
            isLineupSet={teamWithLeague.isLineupSet}
          />
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

      {currentGameweek?.gameweek && currentGameweek.matches.length > 0 && (
        <>
          <h2>This gameweek</h2>
          <ul className="squad-list fixture-list">
            {currentGameweek.matches.map((match) => (
              <FixtureRow key={match.id} match={match} />
            ))}
          </ul>
        </>
      )}

      <h2>
        Standings
        {standingsGameweek && ` — after Gameweek ${standingsGameweek.number}`}
      </h2>
      {standingsGameweek && (
        <p style={{ marginTop: "-0.35rem" }}>
          {standingsGameweek.status === "COMPLETED"
            ? "Final for this gameweek."
            : "Provisional — matches still in progress."}
        </p>
      )}
      {standings === null && <p>Loading…</p>}
      {standings !== null && standings.length === 0 && (
        <p>
          No standings yet —{" "}
          {currentGameweek?.gameweek
            ? `Gameweek ${currentGameweek.gameweek.number}'s scores appear here once its matches finish.`
            : "these appear once a gameweek's matches have been scored."}
        </p>
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
              Updated automatically — busy match days may take a little longer.{" "}
              <span title={STANDINGS_UPDATE_TOOLTIP} style={{ cursor: "help", textDecoration: "underline dotted" }}>
                Last updated {lastUpdatedAt.toLocaleString()}
              </span>
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
