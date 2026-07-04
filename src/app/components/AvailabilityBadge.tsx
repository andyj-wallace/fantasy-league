import type { PlayerAvailabilityStatus } from "../../domain";

/** The cosmetic availability flag from the design doc (it never affects roster rules, scoring,
 * or transfer eligibility — display only). Renders nothing for AVAILABLE players; OUT and
 * QUESTIONABLE get a badge with the provider's reason ("Knee Injury", ...) as hover text. */
export function AvailabilityBadge({
  status,
  reason,
}: {
  status: PlayerAvailabilityStatus;
  reason: string | null;
}) {
  if (status === "AVAILABLE") return null;
  return (
    <span className={status === "OUT" ? "badge badge-red" : "badge"} title={reason ?? undefined}>
      {status === "OUT" ? "Out" : "Doubtful"}
    </span>
  );
}
