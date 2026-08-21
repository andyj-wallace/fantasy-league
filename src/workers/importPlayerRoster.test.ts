import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRosterEntry } from "./footballDataProvider";

/**
 * Covers the out-of-league sweep that importPlayerRoster runs after a complete import — the
 * mechanism that hides relegated clubs' players from player discovery without deleting rows that
 * historic PlayerScore/PlayerMatchStat records still reference — and the two guards in front of
 * it, since the sweep runs unattended on the weekly worker cycle.
 */
const mocks = vi.hoisted(() => ({
  upsertFromRosterImport: vi.fn(),
  hidePlayersOutsideCurrentSeasonSquads: vi.fn(),
  countPlayersInCurrentSeasonSquad: vi.fn(),
  countPlayersInCurrentSeasonSquadMissingFromImport: vi.fn(),
}));

vi.mock("../db/repositories", () => ({
  playersRepository: {
    upsertFromRosterImport: mocks.upsertFromRosterImport,
    hidePlayersOutsideCurrentSeasonSquads: mocks.hidePlayersOutsideCurrentSeasonSquads,
    countPlayersInCurrentSeasonSquad: mocks.countPlayersInCurrentSeasonSquad,
    countPlayersInCurrentSeasonSquadMissingFromImport: mocks.countPlayersInCurrentSeasonSquadMissingFromImport,
  },
}));

import { importPlayerRoster } from "./importPlayerRoster";

const PREMIER_LEAGUE_CLUB_COUNT = 20;

function buildRosterAcrossClubs(clubCount: number, playersPerClub = 2): ProviderRosterEntry[] {
  const entries: ProviderRosterEntry[] = [];
  for (let clubIndex = 0; clubIndex < clubCount; clubIndex++) {
    for (let playerIndex = 0; playerIndex < playersPerClub; playerIndex++) {
      entries.push({
        externalId: `${clubIndex}-${playerIndex}`,
        name: `Player ${clubIndex}-${playerIndex}`,
        club: `Club ${clubIndex}`,
        position: "MID",
      });
    }
  }
  return entries;
}

function providerReturning(entries: ProviderRosterEntry[]) {
  return { fetchPlayerRoster: async () => entries } as unknown as Parameters<typeof importPlayerRoster>[0];
}

/** Sets what the anomaly brake will see: how many players are currently in the league, and how
 * many of them this import would hide. */
function sweepWouldHide(missingCount: number, currentSquadCount: number): void {
  mocks.countPlayersInCurrentSeasonSquad.mockResolvedValue(currentSquadCount);
  mocks.countPlayersInCurrentSeasonSquadMissingFromImport.mockResolvedValue(missingCount);
}

describe("importPlayerRoster — out-of-league sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hidePlayersOutsideCurrentSeasonSquads.mockResolvedValue(0);
    sweepWouldHide(2, 100);
  });

  it("hides players missing from a complete import, passing every externalId it saw", async () => {
    const entries = buildRosterAcrossClubs(PREMIER_LEAGUE_CLUB_COUNT);
    await importPlayerRoster(providerReturning(entries));

    expect(mocks.hidePlayersOutsideCurrentSeasonSquads).toHaveBeenCalledTimes(1);
    expect(mocks.hidePlayersOutsideCurrentSeasonSquads).toHaveBeenCalledWith(entries.map((e) => e.externalId));
  });

  it("skips the sweep when the import saw fewer clubs than the league has", async () => {
    // A club returning an empty squad block is the quiet failure this guards: without it, one bad
    // response would hide every player at the other 19 clubs.
    await importPlayerRoster(providerReturning(buildRosterAcrossClubs(PREMIER_LEAGUE_CLUB_COUNT - 1)));

    expect(mocks.hidePlayersOutsideCurrentSeasonSquads).not.toHaveBeenCalled();
  });

  it("still upserts every player when the sweep is skipped", async () => {
    const entries = buildRosterAcrossClubs(PREMIER_LEAGUE_CLUB_COUNT - 1);
    await importPlayerRoster(providerReturning(entries));

    expect(mocks.upsertFromRosterImport).toHaveBeenCalledTimes(entries.length);
  });

  it("does not sweep on an empty roster response", async () => {
    await importPlayerRoster(providerReturning([]));

    expect(mocks.hidePlayersOutsideCurrentSeasonSquads).not.toHaveBeenCalled();
  });
});

describe("importPlayerRoster — sweep-size anomaly brake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hidePlayersOutsideCurrentSeasonSquads.mockResolvedValue(0);
  });

  it("sweeps an ordinary transfer week's worth of departures", async () => {
    sweepWouldHide(9, 500);
    await importPlayerRoster(providerReturning(buildRosterAcrossClubs(PREMIER_LEAGUE_CLUB_COUNT)));

    expect(mocks.hidePlayersOutsideCurrentSeasonSquads).toHaveBeenCalledTimes(1);
  });

  it("refuses a sweep that would hide more of the league than a transfer week can explain", async () => {
    // A complete, well-formed import of the *wrong* season looks fine to the club-count guard —
    // 20 clubs, full squads — and only shows itself in the size of the sweep it implies.
    sweepWouldHide(442, 1_050);
    await importPlayerRoster(providerReturning(buildRosterAcrossClubs(PREMIER_LEAGUE_CLUB_COUNT)));

    expect(mocks.hidePlayersOutsideCurrentSeasonSquads).not.toHaveBeenCalled();
  });

  it("still upserts every player when the brake stops the sweep", async () => {
    sweepWouldHide(442, 1_050);
    const entries = buildRosterAcrossClubs(PREMIER_LEAGUE_CLUB_COUNT);
    await importPlayerRoster(providerReturning(entries));

    expect(mocks.upsertFromRosterImport).toHaveBeenCalledTimes(entries.length);
  });

  it("lets a deliberate first import sweep the whole mock seed away", async () => {
    // Prod's first real roster import hides all 20 mock players — 100%, correct, and supervised.
    sweepWouldHide(20, 20);
    await importPlayerRoster(providerReturning(buildRosterAcrossClubs(PREMIER_LEAGUE_CLUB_COUNT)), {
      maximumSweepShareOfCurrentSquad: 1,
    });

    expect(mocks.hidePlayersOutsideCurrentSeasonSquads).toHaveBeenCalledTimes(1);
  });

  it("sweeps normally against an empty player table", async () => {
    // Nothing to hide and nothing to divide by — the brake must not read that as an anomaly.
    sweepWouldHide(0, 0);
    await importPlayerRoster(providerReturning(buildRosterAcrossClubs(PREMIER_LEAGUE_CLUB_COUNT)));

    expect(mocks.hidePlayersOutsideCurrentSeasonSquads).toHaveBeenCalledTimes(1);
  });
});
