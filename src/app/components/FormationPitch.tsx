"use client";

import { PlayerNameTapTarget } from "./PlayerNameTapTarget";
import { formationRequiredCounts, type PlayerPosition, type PlayerWithStats, type StartingFormation } from "@/domain";

/**
 * A read-only visual reference showing where the starting XI lines up for the chosen formation —
 * not an input surface. Adding/benching players and setting captaincy happen in the roster list
 * and captaincy controls that sit alongside this component in SquadBuilderPanel.
 */
interface FormationPitchProps {
  formation: StartingFormation | null;
  starters: PlayerWithStats[];
  captainPlayerId: string | null;
  viceCaptainPlayerId: string | null;
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

/** The pitch dot label has little horizontal room before it collides with its neighbors, so it
 * shows only the surname — the last whitespace-separated token of the full name. */
function surnameOf(fullName: string): string {
  const tokens = fullName.trim().split(/\s+/);
  return tokens[tokens.length - 1] ?? fullName;
}

export function FormationPitch({ formation, starters, captainPlayerId, viceCaptainPlayerId }: FormationPitchProps) {
  const startersByPosition = POSITION_ORDER.reduce<Record<PlayerPosition, PlayerWithStats[]>>(
    (map, position) => {
      map[position] = starters.filter((player) => player.position === position);
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

  function renderStarterDot(player: PlayerWithStats, coordinate: PitchCoordinate) {
    const isCaptain = player.id === captainPlayerId;
    const isViceCaptain = player.id === viceCaptainPlayerId;

    return (
      <div
        key={player.id}
        className="pitch-dot-slot"
        style={{ left: `${coordinate.xPercent}%`, top: `${coordinate.yPercent}%` }}
      >
        <span className="pitch-dot" />
        <span className="pitch-dot-label">
          <span className="pitch-dot-name">
            <PlayerNameTapTarget playerId={player.id} playerName={surnameOf(player.name)} accessibleName={player.name} />
          </span>
          {isCaptain && <span className="pitch-dot-armband"> · C</span>}
          {isViceCaptain && <span className="pitch-dot-armband"> · V</span>}
        </span>
      </div>
    );
  }

  return (
    <div className="pitch-wrapper">
      <div className="pitch">
        <div className="pitch-halfway-arc" />
        <div className="pitch-penalty-box" />
        <div className="pitch-six-yard-box" />

        {POSITION_ORDER.flatMap((position) => {
          const coordinates = coordinatesForPosition(position, slotCountByPosition[position], shapeKey);
          const positionStarters = startersByPosition[position];

          return coordinates.map((coordinate, index) => {
            const player = positionStarters[index];
            if (!player) return renderEmptySlot(`${position}-empty-${index}`, coordinate);
            return renderStarterDot(player, coordinate);
          });
        })}
      </div>
    </div>
  );
}
