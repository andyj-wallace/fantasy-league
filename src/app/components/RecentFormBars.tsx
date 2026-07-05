/** Recent-form sparkline: one bar per recent scored match, height encoding that match's fantasy
 * points (single hue, magnitude by height). Points arrive newest-first and are reversed here so
 * bars read oldest → newest, left → right, the way a form trend is naturally scanned. Exact values
 * live in each bar's title tooltip and the group's aria-label, so the data is never height-only.
 * Renders a muted "--" placeholder when there isn't enough history (null / empty). */
export function RecentFormBars({ points }: { points: number[] | null }) {
  if (!points || points.length === 0) {
    return (
      <span className="form-none" aria-label="Recent form: insufficient data">
        --
      </span>
    );
  }

  const chronological = [...points].reverse();
  // Normalize bar heights against the best recent match (floored at 1 so a run of blanks doesn't
  // divide by zero). A non-positive match still shows a short stub rather than nothing.
  const maxPoints = Math.max(1, ...chronological.map((value) => Math.max(value, 0)));

  return (
    <span
      className="form-bars"
      role="img"
      aria-label={`Recent form, oldest to newest: ${chronological.join(", ")} points`}
    >
      {chronological.map((value, index) => {
        const heightPercent = value > 0 ? Math.max(15, (value / maxPoints) * 100) : 8;
        return (
          <span
            key={index}
            className="form-bar"
            style={{ height: `${heightPercent}%` }}
            title={`${value} pt${value === 1 ? "" : "s"}`}
          />
        );
      })}
    </span>
  );
}
