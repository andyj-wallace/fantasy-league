"use client";

import { AvailabilityBadge } from "./AvailabilityBadge";
import { PlayerNameTapTarget } from "./PlayerNameTapTarget";
import type { PlayerPosition, PlayerWithStats } from "@/domain";

interface FormationPitchProps {
  starters: Array<{ player: PlayerWithStats; isStarting: boolean }>;
  bench: Array<{ player: PlayerWithStats; isStarting: boolean }>;
  captainPlayerId: string | null;
  viceCaptainPlayerId: string | null;
  pendingBenchSwapPlayerId: string | null;
  isPlayerLocked: (player: PlayerWithStats) => boolean;
  lockedSinceLabel: (player: PlayerWithStats) => string | undefined;
  onStarterCaptain: (playerId: string) => void;
  onStarterViceCaptain: (playerId: string) => void;
  onStarterBench: (playerId: string) => void;
  onBenchStart: (benchPlayerId: string) => void;
  onSwapTarget: (starterPlayerId: string) => void;
  onCancelSwap: () => void;
}

const POSITION_ORDER: PlayerPosition[] = ["GK", "DEF", "MID", "FWD"];

export function FormationPitch({
  starters,
  bench,
  captainPlayerId,
  viceCaptainPlayerId,
  pendingBenchSwapPlayerId,
  isPlayerLocked,
  lockedSinceLabel,
  onStarterCaptain,
  onStarterViceCaptain,
  onStarterBench,
  onBenchStart,
  onSwapTarget,
  onCancelSwap,
}: FormationPitchProps) {
  const pendingBenchPlayer = bench.find((entry) => entry.player.id === pendingBenchSwapPlayerId)?.player;

  function renderStarterCard(player: PlayerWithStats, isSwapTarget: boolean) {
    const isCaptain = player.id === captainPlayerId;
    const isViceCaptain = player.id === viceCaptainPlayerId;
    const locked = isPlayerLocked(player);

    return (
      <div
        key={player.id}
        className={`pitch-card ${isSwapTarget ? "is-swap-target" : ""}`}
        onClick={() => isSwapTarget && onSwapTarget(player.id)}
      >
        <div className="pitch-card-header">
          <PlayerNameTapTarget playerId={player.id} playerName={player.name} />
          {locked && <span className="badge badge-red" title={lockedSinceLabel(player)}>Locked</span>}
          <AvailabilityBadge status={player.availabilityStatus} reason={player.availabilityReason} />
        </div>

        <div className="pitch-card-meta">
          <span className="badge">{player.position}</span>
          <span className="badge badge-blue" style={{ fontSize: "0.7rem" }}>{player.club}</span>
        </div>

        <div className="pitch-card-actions">
          <button
            className="pitch-armband"
            title={isCaptain ? "Remove captain" : "Make captain"}
            onClick={(e) => {
              e.stopPropagation();
              onStarterCaptain(player.id);
            }}
            disabled={locked}
            style={{
              background: isCaptain ? "var(--color-danger)" : "transparent",
              color: isCaptain ? "var(--color-primary-text)" : "var(--color-text-muted)",
            }}
          >
            C
          </button>
          <button
            className="pitch-armband"
            title={isViceCaptain ? "Remove vice-captain" : "Make vice-captain"}
            onClick={(e) => {
              e.stopPropagation();
              onStarterViceCaptain(player.id);
            }}
            disabled={locked || isCaptain}
            style={{
              background: isViceCaptain ? "var(--color-primary)" : "transparent",
              color: isViceCaptain ? "var(--color-primary-text)" : "var(--color-text-muted)",
            }}
          >
            V
          </button>
          <button
            className="pitch-action-btn"
            onClick={(e) => {
              e.stopPropagation();
              onStarterBench(player.id);
            }}
            disabled={locked}
            title="Move to bench"
          >
            Bench
          </button>
        </div>

        {isSwapTarget && <div className="pitch-card-swap-indicator">Swap</div>}
      </div>
    );
  }

  return (
    <div className="pitch-wrapper">
      {pendingBenchSwapPlayerId && pendingBenchPlayer && (
        <div className="pitch-swap-banner">
          <span>
            Tap a {pendingBenchPlayer.position} to swap in <strong>{pendingBenchPlayer.name}</strong>
          </span>
          <button onClick={onCancelSwap}>Cancel</button>
        </div>
      )}

      <div className="pitch">
        {POSITION_ORDER.map((position) => {
          const positionStarters = starters.filter((entry) => entry.player.position === position);
          if (positionStarters.length === 0) return null;

          return (
            <div key={position} className="pitch-row">
              {positionStarters.map(({ player }) => {
                const isSwapTarget =
                  !!pendingBenchPlayer && pendingBenchPlayer.position === player.position && player.id !== captainPlayerId && player.id !== viceCaptainPlayerId;
                return renderStarterCard(player, isSwapTarget);
              })}
            </div>
          );
        })}
      </div>

      {bench.length > 0 && (
        <div className="pitch-bench">
          {bench.map(({ player }) => {
            const locked = isPlayerLocked(player);
            return (
              <div key={player.id} className="pitch-bench-card">
                <div className="pitch-bench-card-content">
                  <PlayerNameTapTarget playerId={player.id} playerName={player.name} />
                  <span className="badge">{player.position}</span>
                  {locked && <span className="badge badge-red" title={lockedSinceLabel(player)}>Locked</span>}
                  <AvailabilityBadge status={player.availabilityStatus} reason={player.availabilityReason} />
                </div>
                <button
                  className="pitch-bench-btn"
                  onClick={() => onBenchStart(player.id)}
                  disabled={locked}
                  title="Move to starting XI"
                >
                  Start
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
