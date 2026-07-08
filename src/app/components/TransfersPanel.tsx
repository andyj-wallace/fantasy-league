"use client";

import { useEffect, useRef, useState } from "react";
import { authedFetch, fetchJson } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { AvailabilityBadge } from "@/app/components/AvailabilityBadge";
import { LockedBadge } from "@/app/components/LockedBadge";
import { LoadingState } from "@/app/components/LoadingState";
import { StatTile } from "@/app/components/StatTile";
import { formatDayAndTime } from "@/app/lib/formatDate";
import type {
  GameweekStatus,
  MatchStatus,
  PlayerAvailabilityStatus,
  PlayerPosition,
  PlayerWithStats,
  Team,
} from "../../domain";

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
          {filteredReplacements.length === 0 && (
            <li style={{ color: "var(--color-text-muted)" }}>No eligible replacements.</li>
          )}
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
          <button onClick={reset} disabled={isSubmitting}>
            Cancel
          </button>
        </div>
        {error && <p className="msg msg-error">{error}</p>}
      </div>
    </details>
  );
}

/** A team's roster, transfer budget/allowance, and swap controls as pure content (no page chrome),
 * so it can render inside the league hub's slide-up panel or as the standalone /teams/transfers
 * page. Fetches its own data and commits each transfer to POST /teams/:id/transfers immediately.
 * `onPlayerClick` lets the host open a player's details (the hub stacks a popup over this panel);
 * `onChanged` fires after a confirmed transfer so the host can refresh dependent views (budget,
 * standings). */
export function TransfersPanel({
  teamId,
  onPlayerClick,
  onChanged,
}: {
  teamId: string;
  onPlayerClick?: (playerId: string) => void;
  onChanged?: () => void;
}) {
  const [team, setTeam] = useState<Team | null>(null);
  const [available, setAvailable] = useState<AvailableTransfers | null>(null);
  const [allPlayers, setAllPlayers] = useState<PlayerWithStats[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageMessage, setPageMessage] = useState<string | null>(null);

  function loadData() {
    return Promise.all([
      fetchJson<Team>(`${getApiBaseUrl()}/teams/${teamId}`),
      fetchJson<AvailableTransfers>(`${getApiBaseUrl()}/teams/${teamId}/transfers/available`),
      fetchJson<PlayerWithStats[]>(`${getApiBaseUrl()}/players`),
    ]).then(([loadedTeam, loadedAvailable, players]) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    onChanged?.();
    return null;
  }

  if (loadError) return <p className="msg msg-error">{loadError}</p>;
  if (!team || !available) return <LoadingState label="Loading your transfers…" />;

  return (
    <>
      {available.currentGameweek && (
        <div className="gameweek-banner" style={{ marginTop: 0 }}>
          <strong>Gameweek {available.currentGameweek.number}</strong>
          <span className="gameweek-banner-deadline">
            {new Date(available.currentGameweek.deadlineAt).getTime() < Date.now()
              ? `Deadline passed (${formatDayAndTime(available.currentGameweek.deadlineAt)}) — players lock at their match's kickoff`
              : `Deadline ${formatDayAndTime(available.currentGameweek.deadlineAt)}`}
          </span>
        </div>
      )}

      <div className="stat-row">
        <StatTile label="Free transfers" value={available.bankedFreeTransferCount} />
        <StatTile
          label="Next transfer"
          value={available.nextTransferPointsCost === 0 ? "Free" : `-${available.nextTransferPointsCost}pts`}
        />
        <StatTile label="Budget" value={`£${available.remainingBudgetInMillions}M`} />
      </div>

      <p>
        You get 2 free transfers each gameweek. Extra transfers cost 10 pts each.
        {available.currentGameweek &&
          ` Unused free transfers carry over when Gameweek ${available.currentGameweek.number} completes.`}
      </p>

      {pageMessage && <p className="msg msg-success">{pageMessage}</p>}

      <h3>Current Roster</h3>
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
                  <td>
                    {onPlayerClick ? (
                      <button type="button" className="player-tap-target" onClick={() => onPlayerClick(player.id)}>
                        {player.name}
                      </button>
                    ) : (
                      player.name
                    )}
                  </td>
                  <td>{player.club}</td>
                  <td>{player.position}</td>
                  <td>£{player.priceInMillions}M</td>
                  <td>{player.isStarting ? "Starting" : "Bench"}</td>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", flexWrap: "wrap" }}>
                      {player.isLocked ? <LockedBadge /> : <span className="badge badge-green">Available</span>}
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

      <h3>Transfers this gameweek</h3>
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
    </>
  );
}
