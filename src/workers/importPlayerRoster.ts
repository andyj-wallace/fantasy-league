import { playersRepository } from "../db/repositories";
import type { FootballDataProvider } from "./footballDataProvider";

/** The Premier League always fields 20 clubs, so a roster import that surfaced players from fewer
 * than this saw an incomplete league and must not be used to hide anyone. */
const PREMIER_LEAGUE_CLUB_COUNT = 20;

/** How much of the currently-visible roster a single sweep may hide before it is treated as an
 * anomaly rather than a transfer week. Squads turn over by a handful of players at a time, so a
 * quarter of the league leaving between two weekly imports is not a football event — it is a
 * response that is well-formed but about the wrong league or the wrong season. The deliberate
 * first-import case (mock seed data giving way to a real roster) is over this line by design and
 * opts past it explicitly. */
const DEFAULT_MAXIMUM_SWEEP_SHARE_OF_CURRENT_SQUAD = 0.25;

export interface PlayerRosterImportOptions {
  /** Raises or lowers the anomaly brake above. Pass 1 to sweep whatever the import implies —
   * correct for a deliberate, supervised first import, wrong for the weekly worker. */
  maximumSweepShareOfCurrentSquad?: number;
}

/** Pulls the full Premier League player list from the provider and upserts every entry by
 * externalId — the only path that creates Player rows. Needed before fixture player-stat
 * imports or availability syncs have anyone to attribute provider data to.
 *
 * A complete import is also the only reliable statement of who is *not* in the league any more, so
 * it doubles as the sweep that hides relegated clubs' players and players transferred out (their
 * rows stay — historic scores reference them — they just leave player discovery). Two guards stand
 * in front of that sweep, because it runs unattended on the weekly worker cycle and a wrong sweep
 * empties player discovery for every manager:
 *
 * 1. **Club count** — the import must have seen all 20 clubs. A provider error already throws out
 *    of fetchPlayerRoster before reaching this point; this covers the quieter case of a club
 *    returning an empty squad block.
 * 2. **Sweep size** — the sweep must not hide more than maximumSweepShareOfCurrentSquad of the
 *    players currently in the league. Guard 1 cannot see a response that is complete and
 *    well-formed but describes the wrong season; the size of the sweep it implies can. */
export async function importPlayerRoster(
  provider: FootballDataProvider,
  options: PlayerRosterImportOptions = {},
): Promise<void> {
  const maximumSweepShareOfCurrentSquad =
    options.maximumSweepShareOfCurrentSquad ?? DEFAULT_MAXIMUM_SWEEP_SHARE_OF_CURRENT_SQUAD;

  console.log("[importPlayerRoster] fetching player roster from provider...");
  const rosterEntries = await provider.fetchPlayerRoster();
  console.log(`[importPlayerRoster] upserting ${rosterEntries.length} players...`);
  for (const entry of rosterEntries) {
    await playersRepository.upsertFromRosterImport(entry);
  }

  const clubsSeen = new Set(rosterEntries.map((entry) => entry.club));
  if (clubsSeen.size < PREMIER_LEAGUE_CLUB_COUNT) {
    console.warn(
      `[importPlayerRoster] saw only ${clubsSeen.size} of ${PREMIER_LEAGUE_CLUB_COUNT} clubs — skipping the ` +
        "out-of-league sweep rather than risk hiding players on a partial import.",
    );
    console.log("[importPlayerRoster] done");
    return;
  }

  const seenExternalIds = rosterEntries.map((entry) => entry.externalId);
  const playersInCurrentSquad = await playersRepository.countPlayersInCurrentSeasonSquad();
  const wouldHideCount = await playersRepository.countPlayersInCurrentSeasonSquadMissingFromImport(seenExternalIds);
  const wouldHideShare = playersInCurrentSquad === 0 ? 0 : wouldHideCount / playersInCurrentSquad;

  if (wouldHideShare > maximumSweepShareOfCurrentSquad) {
    console.warn(
      `[importPlayerRoster] the sweep would hide ${wouldHideCount} of ${playersInCurrentSquad} players ` +
        `(${Math.round(wouldHideShare * 100)}%), over the ${Math.round(maximumSweepShareOfCurrentSquad * 100)}% ceiling — ` +
        "skipping it. The import looked complete, so this is more likely the wrong season than a real exodus; " +
        "re-run hydrate:roster with --allow-large-sweep once the roster has been eyeballed.",
    );
    console.log("[importPlayerRoster] done");
    return;
  }

  const hiddenCount = await playersRepository.hidePlayersOutsideCurrentSeasonSquads(seenExternalIds);
  console.log(`[importPlayerRoster] hid ${hiddenCount} players no longer in a Premier League squad`);
  console.log("[importPlayerRoster] done");
}
