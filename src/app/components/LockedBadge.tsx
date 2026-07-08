/** The red "Locked" badge shown on a player whose club match has kicked off (so their squad slot
 * can no longer be changed). When `contextLabel` is supplied it explains why/since when: shown as a
 * hover tooltip and exposed to screen readers, while the visible "Locked" text is hidden from them
 * to avoid reading it twice. */
export function LockedBadge({ contextLabel }: { contextLabel?: string }) {
  return (
    <span className="badge badge-red" title={contextLabel}>
      <span aria-hidden={!!contextLabel}>Locked</span>
      {contextLabel && <span className="sr-only">{contextLabel}</span>}
    </span>
  );
}
