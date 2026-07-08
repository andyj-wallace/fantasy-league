import type { CSSProperties, ReactNode } from "react";

/** One labelled figure inside a `.stat-row` — the budget / squad / points / availability tiles
 * repeated across the squad-builder, transfers, and player-detail panels. Keeps the `.stat-tile`
 * markup in one place so every tile reads and styles identically. */
export function StatTile({
  label,
  value,
  valueStyle,
}: {
  label: string;
  value: ReactNode;
  valueStyle?: CSSProperties;
}) {
  return (
    <div className="stat-tile">
      <span className="stat-tile-label">{label}</span>
      <span className="stat-tile-value" style={valueStyle}>
        {value}
      </span>
    </div>
  );
}
