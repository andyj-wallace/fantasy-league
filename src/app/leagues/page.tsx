"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { API_CACHE_TTL_MS, getCachedJson } from "@/app/lib/apiCache";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredToken, getStoredUserId } from "@/app/lib/auth";
import type { TeamWithLeague } from "@/app/lib/teamTypes";
import { TeamLeagueLinks } from "@/app/components/TeamLeagueLinks";
import { GameweekBanner } from "@/app/components/GameweekBanner";
import { GameweekFixtures } from "@/app/components/GameweekFixtures";
import { LeagueInviteRow } from "@/app/components/LeagueInviteRow";
import { LeagueStandingsSection, type StandingsResponse } from "@/app/components/LeagueStandingsSection";
import { LoadingState } from "@/app/components/LoadingState";
import { Overlay } from "@/app/components/Overlay";
import { TransfersPanel } from "@/app/components/TransfersPanel";
import { SquadBuilderPanel } from "@/app/components/SquadBuilderPanel";
import { PlayerDetailPanel } from "@/app/components/PlayerDetailPanel";
import { PlayerDetailContext } from "@/app/lib/playerDetailContext";
import { useCurrentGameweekContext } from "@/app/lib/gameweekContext";

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
  const searchParams = useSearchParams();
  const leagueId = searchParams.get("leagueId") ?? "";
  const openPanel = searchParams.get("panel");
  const panelTeamId = searchParams.get("teamId") ?? "";
  const detailPlayerId = searchParams.get("playerId") ?? "";
  const router = useRouter();
  const [teamWithLeague, setTeamWithLeague] = useState<TeamWithLeague | null>(null);
  const [standingsResponse, setStandingsResponse] = useState<StandingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentGameweek = useCurrentGameweekContext();

  /** Loads (or reloads) the two league-scoped reads the page renders — the user's team summary and
   * the standings. Reused by the initial mount and by the on-close refresh after a transfer, so a
   * budget change or a re-rank shows without a full navigation. */
  function loadLeague() {
    getCachedJson<TeamWithLeague[]>(`${getApiBaseUrl()}/me/teams`, API_CACHE_TTL_MS.SHORT)
      .then((result) => {
        const match = result.find(({ league }) => league.id === leagueId);
        if (!match) {
          setError("You're not part of this league.");
          return;
        }
        setTeamWithLeague(match);
      })
      .catch(() => setError("Could not load this league — try refreshing."));

    getCachedJson<StandingsResponse>(`${getApiBaseUrl()}/leagues/${leagueId}/standings`, API_CACHE_TTL_MS.STANDINGS)
      .then(setStandingsResponse)
      .catch(() => setError("Could not load this league's standings — try refreshing."));
  }

  useEffect(() => {
    if (!getStoredToken()) {
      router.push("/login");
      return;
    }
    if (!leagueId) {
      setError("No league specified — open a league from your home page.");
      return;
    }
    loadLeague();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueId, router]);

  /** Overlay routing lives in the query string so panels are deep-linkable and the browser Back
   * button (and Escape/backdrop) close them: opening pushes a history entry, closing pops it. A
   * player popup can stack on top of the transfers panel by adding ?playerId= while ?panel= stays. */
  function openTeamPanel(panel: "transfers" | "squad", teamId: string) {
    const params = new URLSearchParams({ leagueId, panel, teamId });
    router.push(`/leagues?${params.toString()}`);
  }

  function openPlayer(playerId: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("playerId", playerId);
    router.push(`/leagues?${params.toString()}`);
  }

  function closeTopPanel() {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.replace(`/leagues?leagueId=${leagueId}`);
    }
  }

  return (
    <>
    <main className="page-with-sidebar">
      <GameweekBanner current={currentGameweek} />

      <div className="page-content">
      <h1>{teamWithLeague?.league.name ?? "League"}</h1>

      {error && <p className="msg msg-error">{error}</p>}
      {!error && !teamWithLeague && <p aria-busy="true">Loading…</p>}

      {teamWithLeague && (
        <p style={{ marginBottom: "0.75rem" }}>
          <TeamLeagueLinks
            team={teamWithLeague.team}
            league={teamWithLeague.league}
            rosterCount={teamWithLeague.rosterCount}
            isLineupSet={teamWithLeague.isLineupSet}
            onOpenSquad={(teamId) => openTeamPanel("squad", teamId)}
            onOpenTransfers={(teamId) => openTeamPanel("transfers", teamId)}
          />
        </p>
      )}

      {teamWithLeague && <LeagueInviteRow league={teamWithLeague.league} />}

      {teamWithLeague && getStoredUserId() === teamWithLeague.league.commissionerUserId && (
        <div className="link-list">
          <Link href={`/leagues/settings?leagueId=${leagueId}`}>League Settings</Link>
        </div>
      )}

      <LeagueStandingsSection standingsResponse={standingsResponse} currentGameweek={currentGameweek} />

      <GameweekFixtures current={currentGameweek} />

      <div className="link-list">
        <Link href="/leagues/create">Create League</Link>
        <Link href="/leagues/join">Join League</Link>
      </div>
      </div>
    </main>

    {openPanel === "transfers" && panelTeamId && (
      <Overlay title="Transfers" variant="panel" onClose={closeTopPanel}>
        <TransfersPanel teamId={panelTeamId} onPlayerClick={openPlayer} onChanged={loadLeague} />
      </Overlay>
    )}

    {openPanel === "squad" && panelTeamId && (
      <Overlay title="Squad Builder" variant="panel" onClose={closeTopPanel}>
        <PlayerDetailContext.Provider value={{ openPlayer }}>
          <SquadBuilderPanel teamId={panelTeamId} onChanged={loadLeague} />
        </PlayerDetailContext.Provider>
      </Overlay>
    )}

    {detailPlayerId && (
      <Overlay title="Player details" variant="popup" onClose={closeTopPanel}>
        <PlayerDetailPanel playerId={detailPlayerId} />
      </Overlay>
    )}
    </>
  );
}
