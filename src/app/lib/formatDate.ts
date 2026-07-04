/** "Wed 22 Jul, 11:30" — the one format used for kickoff times and gameweek deadlines, in the
 * viewer's local timezone. Short enough for badges and match rows, unambiguous across weeks. */
export function formatDayAndTime(isoDate: string | Date): string {
  const date = typeof isoDate === "string" ? new Date(isoDate) : isoDate;
  const dayPart = date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const timePart = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${dayPart}, ${timePart}`;
}
