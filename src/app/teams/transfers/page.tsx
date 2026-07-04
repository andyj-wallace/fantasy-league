"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { AvailabilityBadge } from "@/app/components/AvailabilityBadge";
import { LoadingState } from "@/app/components/LoadingState";
import { useRequireAuth } from "@/app/lib/useRequireAuth";
import { formatDayAndTime } from "@/app/lib/formatDate";
import type {
  GameweekStatus,
  MatchStatus,
  PlayerAvailabilityStatus,
  PlayerPosition,
  PlayerWithStats,
  Team,
} from "../../../domain";

interface RosterNextMatch {
  opponent: string;
  home: boolean;
  kickoffAt: string;
  status: MatchStatus;
}

interface RosterEntry {
  id: string;
  name: string;
  club: string;
  position: PlayerPosition;
  priceInMillions: number;
  totalFantasyPoints: number;
  recentFormPoints: number[] | null;
  availabilityStatus: PlayerAvailabilityStatus;
  availabilityReason: string | null;
  isStarting: boolean;
  isLocked: boolean;
  nextMatch: RosterNextMatch | null;
}

interface TransferEntry {
  id: string;
  playerOutId: string;
  playerInId: string;
  playerOutName: string;
  playerInName: string;
  pointsCost: number;
  createdAt: string;
}

interface AvailableTransfers {
  currentGameweek: { number: number; status: GameweekStatus; deadlineAt: string } | null;
  bankedFreeTransferCount: number;
  maxBankedFreeTransferCount: number;
  nextTransferPointsCost: number;
  remainingBudgetInMillions: number;
  roster: RosterEntry[];
  transfersThisGameweek: TransferEntry[];
}

/** "v Chelsea (H), kicked off Sat 19 Jul, 15:00" / "Locks Sat 19 Jul, 15:00" — the context line
 * that explains a Locked badge or warns about an upcoming lock. */
function describeLockContext(player: RosterEntry): string | null {
  if (!player.nextMatch) return null;
  const fixture = `v ${player.nextMatch.opponent} (${player.nextMatch.home ? "H" : "A"})`;
  const kickoff = formatDayAndTime(player.nextMatch.kickoffAt);
  if (player.isLocked) {
    return player.nextMatch.status === "COMPLETED"
      ? `${fixture}, played ${kickoff}`
      : `${fixture}, kicked off ${kickoff}`;
  }
  if (player.nextMatch.status === "POSTPONED") return `${fixture}, postponed`;
  return `Locks ${kickoff}`;
}

/**
 * The collapsible "swap this player" control for one roster row. A <select> doesn't scale once
 * the eligible-replacement list gets long (the real player pool, unlike the V1 mock data, can
 * run into the hundreds for a single position) — a searchable, scrollable list inside a native
 * <details> disclosure does, without needing any extra open/close state.
 */
function TransferPicker({
  outgoingPlayer,
  eligibleReplacements,
  onConfirm,
}: {
  outgoingPlayer: RosterEntry;
  eligibleReplacements: PlayerWithStats[];
  onConfirm: (replacementPlayerId: string) => Promise<string | null>;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedReplacementId, setSelectedReplacementId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredReplacements = eligibleReplacements.filter((player) =>
    player.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  function reset() {
    setSearchQuery("");
    setSelectedReplacementId("");
    setError(null);
    if (detailsRef.current) detailsRef.current.open = false;
  }

  async function handleConfirm() {
    if (!selectedReplacementId) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const errorMessage = await onConfirm(selectedReplacementId);
      if (errorMessage) {
        setError(errorMessage);
      } else {
        reset();
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <details ref={detailsRef} className="transfer-picker">
      <summary>Transfer out</summary>
      <div className="transfer-picker-body">
        <input
          placeholder={`Search replacement ${outgoingPlayer.position}s by name`}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        <ul className="transfer-picker-list">
          {filteredReplacements.length === 0 && <li style={{ color: "var(--color-text-muted)" }}>No eligible replacements.</li>}
          {filteredReplacements.map((player) => (
            <li key={player.id}>
              <label style={{ fontWeight: 400, cursor: "pointer" }}>
                <input
                  type="radio"
                  name={`replacement-for-${outgoingPlayer.id}`}
                  checked={selectedReplacementId === player.id}
                  onChange={() => setSelectedReplacementId(player.id)}
                />{" "}
                {player.name} — {player.club} — £{player.priceInMillions}M — {player.totalFantasyPoints}pts
              </label>
            </li>
          ))}
        </ul>
        <div className="transfer-picker-actions">
          <button className="btn-primary" onClick={handleConfirm} disabled={!selectedReplacementId || isSubmitting}>
            Confirm
          </button>
          <button onClick={reset} disabled={isSubmitting}>Cancel</button>
        </div>
        {error && <p className="msg msg-error">{error}</p>}
      </div>
    </details>
  );
}

/** The team is addressed by a ?teamId= query param rather than a path segment because the
 * frontend deploys as a static export (see "Deployment (AWS)" in the architecture doc) — runtime
 * UUIDs can't be enumerated as static paths at build time. The Suspense boundary is required for
 * useSearchParams under static prerendering. */
export default function TransfersPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <TransfersPageContent />
    </Suspense>
  );
}

function TransfersPageContent() {
  useRequireAuth();
  const teamId = useSearchParams().get("teamId") ?? "";

  const [team, setTeam] = useState<Team | null>(null);
  const [available, setAvailable] = useState<AvailableTransfers | null>(null);
  const [allPlayers, setAllPlayers] = useState<PlayerWithStats[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageMessage, setPageMessage] = useState<string | null>(null);

  function loadData() {
    return Promise.all([
      authedFetch(`${getApiBaseUrl()}/teams/${teamId}`).then((response) => response.json()),
      authedFetch(`${getApiBaseUrl()}/teams/${teamId}/transfers/available`).then((response) => response.json()),
      authedFetch(`${getApiBaseUrl()}/players`).then((response) => response.json()),
    ]).then(([loadedTeam, loadedAvailable, players]: [Team, AvailableTransfers, PlayerWithStats[]]) => {
      setTeam(loadedTeam);
      setAvailable(loadedAvailable);
      setAllPlayers(players);
    });
  }

  useEffect(() => {
    if (!teamId) {
      setLoadError("No team specified — open Transfers from your league page.");
      return;
    }
    loadData().catch(() => setLoadError("Could not load this team's transfers — try refreshing."));
  }, [teamId]);

  function eligibleReplacements(outgoing: RosterEntry): PlayerWithStats[] {
    if (!available) return [];
    const rosterPlayerIds = new Set(available.roster.map((player) => player.id));
    const budgetAllowance = available.remainingBudgetInMillions + outgoing.priceInMillions;
    return allPlayers.filter(
      (player) =>
        player.position === outgoing.position &&
        !rosterPlayerIds.has(player.id) &&
        player.priceInMillions <= budgetAllowance,
    );
  }

  async function handleConfirmTransfer(outgoing: RosterEntry, replacementPlayerId: string): Promise<string | null> {
    setPageMessage(null);
    const replacement = allPlayers.find((player) => player.id === replacementPlayerId);
    const response = await authedFetch(`${getApiBaseUrl()}/teams/${teamId}/transfers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerOutId: outgoing.id, playerInId: replacementPlayerId }),
    });
    const body = await response.json();
    if (!response.ok) return body.message ?? "Could not make this transfer.";

    await loadData();
    setPageMessage(`Transfer confirmed: ${outgoing.name} → ${replacement?.name ?? replacementPlayerId}.`);
    return null;
  }

  if (loadError) return <main><p className="msg msg-error">{loadError}</p></main>;
  if (!team || !available) return <LoadingState label="Loading your transfers…" />;

  return (
    <main className="page-with-sidebar">
      {available.currentGameweek && (
        <div className="gameweek-banner">
          <strong>Gameweek {available.currentGameweek.number}</strong>
          <span className="gameweek-banner-deadline">
            {new Date(available.currentGameweek.deadlineAt).getTime() < Date.now()
              ? `Deadline passed (${formatDayAndTime(available.currentGameweek.deadlineAt)}) — players lock at their match's kickoff`
              : `Deadline ${formatDayAndTime(available.currentGameweek.deadlineAt)}`}
          </span>
        </div>
      )}

      <div className="page-content">
      <p style={{ marginBottom: "0.35rem" }}>
        <Link href={`/leagues?leagueId=${team.leagueId}`}>← Back to league</Link>
      </p>
      <h1>Transfers — {team.name}</h1>

      <div className="stat-row">
        <div className="stat-tile">
          <span className="stat-tile-label">Free transfers</span>
          <span className="stat-tile-value">
            {available.bankedFreeTransferCount}/{available.maxBankedFreeTransferCount}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Next transfer</span>
          <span className="stat-tile-value">
            {available.nextTransferPointsCost === 0 ? "Free" : `-${available.nextTransferPointsCost}pts`}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Budget</span>
          <span className="stat-tile-value">£{available.remainingBudgetInMillions}M</span>
        </div>
      </div>

      <p>
        You get 2 free transfers each gameweek, banked up to {available.maxBankedFreeTransferCount}. Extra
        transfers cost 10 pts each.
        {available.currentGameweek &&
          ` Unused free transfers carry over when Gameweek ${available.currentGameweek.number} completes.`}
      </p>

      {pageMessage && <p className="msg msg-success">{pageMessage}</p>}

      <h2>Current Roster</h2>
      {available.roster.length === 0 ? (
        <p>No roster set yet — build your squad first.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Club</th>
                <th>Pos</th>
                <th>Price</th>
                <th>Role</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {available.roster.map((player) => (
                <tr key={player.id}>
                  <td>{player.name}</td>
                  <td>{player.club}</td>
                  <td>{player.position}</td>
                  <td>£{player.priceInMillions}M</td>
                  <td>{player.isStarting ? "Starting" : "Bench"}</td>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", flexWrap: "wrap" }}>
                      {player.isLocked
                        ? <span className="badge badge-red">Locked</span>
                        : <span className="badge badge-green">Available</span>}
                      <AvailabilityBadge status={player.availabilityStatus} reason={player.availabilityReason} />
                    </span>
                    {describeLockContext(player) && (
                      <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", marginTop: "0.15rem" }}>
                        {describeLockContext(player)}
                      </div>
                    )}
                  </td>
                  <td>
                    {!player.isLocked && (
                      <TransferPicker
                        outgoingPlayer={player}
                        eligibleReplacements={eligibleReplacements(player)}
                        onConfirm={(replacementPlayerId) => handleConfirmTransfer(player, replacementPlayerId)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Transfers this gameweek</h2>
      {available.transfersThisGameweek.length === 0 ? (
        <p>No transfers made this gameweek yet.</p>
      ) : (
        <ul className="squad-list" style={{ marginTop: "0.5rem" }}>
          {available.transfersThisGameweek.map((transfer) => (
            <li key={transfer.id}>
              <span>{transfer.playerOutName}</span>
              <span style={{ color: "var(--color-text-muted)" }}>→</span>
              <span>{transfer.playerInName}</span>
              <span className={transfer.pointsCost === 0 ? "badge badge-green" : "badge badge-red"}>
                {transfer.pointsCost === 0 ? "free" : `-${transfer.pointsCost}pts`}
              </span>
            </li>
          ))}
        </ul>
      )}
      </div>
    </main>
  );
}
