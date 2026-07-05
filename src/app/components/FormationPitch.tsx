"use client";

import { useState } from "react";
import { AvailabilityBadge } from "./AvailabilityBadge";
import { PlayerNameTapTarget } from "./PlayerNameTapTarget";
import { formationRequiredCounts, type PlayerPosition, type PlayerWithStats, type StartingFormation } from "@/domain";

type StarterEntry = { player: PlayerWithStats; isStarting: boolean };

interface FormationPitchProps {
  formation: StartingFormation | null;
  starters: StarterEntry[];
  bench: StarterEntry[];
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

interface PitchCoordinate {
  xPercent: number;
  yPercent: number;
}

const GOALKEEPER_COORDINATE: PitchCoordinate = { xPercent: 50, yPercent: 92 };

type OutfieldPosition = "DEF" | "MID" | "FWD";

/** Fallback vertical band (percent from the halfway line) for a position row when we
 * haven't hand-placed a bespoke shape for the current DEF-MID-FWD split below. */
const OUTFIELD_ROW_Y_PERCENT: Record<OutfieldPosition, number> = {
  DEF: 74,
  MID: 46,
  FWD: 18,
};

/** Hand-placed slot coordinates for formations with a designed shape, keyed by
 * "DEF-MID-FWD" (same key shape as domain's FORMATION_BY_DEFENDER_MIDFIELDER_FORWARD_SHAPE).
 * Formations without an entry here fall back to an evenly-spaced straight row per position. */
const HAND_PLACED_OUTFIELD_SHAPES: Partial<Record<string, Record<OutfieldPosition, PitchCoordinate[]>>> = {
  "4-3-3": {
    DEF: [
      { xPercent: 12, yPercent: 74 },
      { xPercent: 38, yPercent: 74 },
      { xPercent: 62, yPercent: 74 },
      { xPercent: 88, yPercent: 74 },
    ],
    MID: [
      { xPercent: 25, yPercent: 40 },
      { xPercent: 50, yPercent: 52 },
      { xPercent: 75, yPercent: 40 },
    ],
    FWD: [
      { xPercent: 18, yPercent: 18 },
      { xPercent: 50, yPercent: 18 },
      { xPercent: 82, yPercent: 18 },
    ],
  },
};

function evenlySpacedXPercentages(count: number): number[] {
  return Array.from({ length: count }, (_, index) => ((index + 1) / (count + 1)) * 100);
}

function coordinatesForPosition(position: PlayerPosition, slotCount: number, shapeKey: string): PitchCoordinate[] {
  if (position === "GK") return slotCount > 0 ? [GOALKEEPER_COORDINATE] : [];
  if (slotCount === 0) return [];

  const handPlaced = HAND_PLACED_OUTFIELD_SHAPES[shapeKey]?.[position];
  if (handPlaced && handPlaced.length === slotCount) return handPlaced;

  return evenlySpacedXPercentages(slotCount).map((xPercent) => ({
    xPercent,
    yPercent: OUTFIELD_ROW_Y_PERCENT[position],
  }));
}

export function FormationPitch({
  formation,
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
  const [selectedStarterPlayerId, setSelectedStarterPlayerId] = useState<string | null>(null);

  const pendingBenchPlayer = bench.find((entry) => entry.player.id === pendingBenchSwapPlayerId)?.player;
  // The swap flow and the tap-to-select action bar are mutually exclusive contextual UIs.
  const selectedStarter = !pendingBenchSwapPlayerId
    ? starters.find((entry) => entry.player.id === selectedStarterPlayerId)?.player
    : undefined;

  const startersByPosition = POSITION_ORDER.reduce<Record<PlayerPosition, StarterEntry[]>>(
    (map, position) => {
      map[position] = starters.filter((entry) => entry.player.position === position);
      return map;
    },
    { GK: [], DEF: [], MID: [], FWD: [] },
  );

  const startingCountsByPosition: Record<PlayerPosition, number> = {
    GK: startersByPosition.GK.length,
    DEF: startersByPosition.DEF.length,
    MID: startersByPosition.MID.length,
    FWD: startersByPosition.FWD.length,
  };

  /** The pitch always shows every slot the chosen formation defines — DEF/MID/FWD line counts,
   * plus the one ever-present GK slot — even where no player has been assigned to it yet, so the
   * formation's shape is visible before the squad is fully built. Falls back to whatever's
   * actually filled when no formation is chosen (matches domain's "pick a formation first" rule
   * on promoting a player to starting, so this only bites for inconsistent/seeded data). */
  const requiredCountsByPosition = formation ? formationRequiredCounts(formation) : null;
  const slotCountByPosition: Record<PlayerPosition, number> = POSITION_ORDER.reduce(
    (counts, position) => {
      counts[position] = Math.max(requiredCountsByPosition?.[position] ?? 0, startingCountsByPosition[position]);
      return counts;
    },
    { GK: 0, DEF: 0, MID: 0, FWD: 0 },
  );
  const shapeKey = formation ?? `${startingCountsByPosition.DEF}-${startingCountsByPosition.MID}-${startingCountsByPosition.FWD}`;

  function renderEmptySlot(key: string, coordinate: PitchCoordinate) {
    return (
      <div key={key} className="pitch-dot-slot" style={{ left: `${coordinate.xPercent}%`, top: `${coordinate.yPercent}%` }}>
        <span className="pitch-dot pitch-dot-empty" />
      </div>
    );
  }

  function renderStarterDot(player: PlayerWithStats, coordinate: PitchCoordinate, isSwapTarget: boolean) {
    const isCaptain = player.id === captainPlayerId;
    const isViceCaptain = player.id === viceCaptainPlayerId;
    const isSelected = player.id === selectedStarterPlayerId && !pendingBenchSwapPlayerId;

    function handleDotClick() {
      if (isSwapTarget) {
        onSwapTarget(player.id);
        return;
      }
      if (pendingBenchSwapPlayerId) return;
      setSelectedStarterPlayerId((current) => (current === player.id ? null : player.id));
    }

    return (
      <div
        key={player.id}
        className={`pitch-dot-slot pitch-dot-slot-filled ${isSwapTarget ? "is-swap-target" : ""} ${isSelected ? "is-selected" : ""}`}
        style={{ left: `${coordinate.xPercent}%`, top: `${coordinate.yPercent}%` }}
        onClick={handleDotClick}
      >
        {isSwapTarget && <span className="pitch-dot-swap-indicator">Swap</span>}
        <span className="pitch-dot" />
        <span className="pitch-dot-label">
          <span className="pitch-dot-name">
            <PlayerNameTapTarget playerId={player.id} playerName={player.name} />
          </span>
          {isCaptain && <span className="pitch-dot-armband"> · C</span>}
          {isViceCaptain && <span className="pitch-dot-armband"> · V</span>}
        </span>
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
        <div className="pitch-halfway-arc" />
        <div className="pitch-penalty-box" />
        <div className="pitch-six-yard-box" />

        {POSITION_ORDER.flatMap((position) => {
          const coordinates = coordinatesForPosition(position, slotCountByPosition[position], shapeKey);
          const positionStarters = startersByPosition[position];

          return coordinates.map((coordinate, index) => {
            const starterEntry = positionStarters[index];
            if (!starterEntry) return renderEmptySlot(`${position}-empty-${index}`, coordinate);

            const { player } = starterEntry;
            const isSwapTarget =
              !!pendingBenchPlayer &&
              pendingBenchPlayer.position === player.position &&
              player.id !== captainPlayerId &&
              player.id !== viceCaptainPlayerId;
            return renderStarterDot(player, coordinate, isSwapTarget);
          });
        })}
      </div>

      {selectedStarter && (
        <div className="pitch-action-bar">
          <span className="pitch-action-bar-name">
            {selectedStarter.name}
            {isPlayerLocked(selectedStarter) && (
              <span className="badge badge-red" title={lockedSinceLabel(selectedStarter)}>Locked</span>
            )}
          </span>
          <div className="pitch-action-bar-buttons">
            <button
              disabled={isPlayerLocked(selectedStarter)}
              onClick={() => {
                onStarterCaptain(selectedStarter.id);
                setSelectedStarterPlayerId(null);
              }}
            >
              {selectedStarter.id === captainPlayerId ? "Remove captain" : "Make captain"}
            </button>
            <button
              disabled={isPlayerLocked(selectedStarter) || selectedStarter.id === captainPlayerId}
              onClick={() => {
                onStarterViceCaptain(selectedStarter.id);
                setSelectedStarterPlayerId(null);
              }}
            >
              {selectedStarter.id === viceCaptainPlayerId ? "Remove vice-captain" : "Make vice-captain"}
            </button>
            <button
              disabled={isPlayerLocked(selectedStarter)}
              onClick={() => {
                onStarterBench(selectedStarter.id);
                setSelectedStarterPlayerId(null);
              }}
            >
              Bench
            </button>
            <button className="pitch-action-bar-close" onClick={() => setSelectedStarterPlayerId(null)} title="Close">
              ×
            </button>
          </div>
        </div>
      )}

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
