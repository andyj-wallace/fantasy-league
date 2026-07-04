"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { PlayerNameTapTarget } from "../../components/PlayerNameTapTarget";
import { GameweekBanner } from "@/app/components/GameweekBanner";
import { AvailabilityBadge } from "@/app/components/AvailabilityBadge";
import { LoadingState } from "@/app/components/LoadingState";
import { useCurrentGameweek } from "@/app/lib/useCurrentGameweek";
import { useRequireAuth } from "@/app/lib/useRequireAuth";
import { formatDayAndTime } from "@/app/lib/formatDate";
import {
  formationRequiredCounts,
  isClubLocked,
  MAX_PLAYERS_PER_CLUB,
  REQUIRED_GOALKEEPER_COUNT,
  SQUAD_SIZE,
  STARTING_SQUAD_BUDGET_IN_MILLIONS,
  VALID_STARTING_FORMATIONS,
  deriveStartingFormation,
  validateSquadComposition,
  type Match,
  type PlayerPosition,
  type PlayerWithStats,
  type StartingFormation,
  type Team,
  type TeamRosterSlot,
} from "../../../domain";

const ALL_POSITIONS: PlayerPosition[] = ["GK", "DEF", "MID", "FWD"];
const PLAYERS_PER_PAGE = 25;

function describeRecentForm(player: PlayerWithStats): string {
  if (!player.recentFormPoints) return "Insufficient Data";
  return player.recentFormPoints.join(", ");
}

/** Save feedback in three distinct shapes: full success, partial apply (the server skipped
 * changes to locked players and returned lockedChangeWarnings), and outright rejection. Kept
 * structured rather than as one string so partial saves can't be misread as clean successes. */
interface SaveResult {
  kind: "success" | "partial" | "error";
  messages: string[];
}

/** The team is addressed by a ?teamId= query param rather than a path segment because the
 * frontend deploys as a static export (see "Deployment (AWS)" in the architecture doc) — runtime
 * UUIDs can't be enumerated as static paths at build time. The Suspense boundary is required for
 * useSearchParams under static prerendering. */
export default function SquadBuilderPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <SquadBuilderPageContent />
    </Suspense>
  );
}

function SquadBuilderPageContent() {
  useRequireAuth();
  const teamId = useSearchParams().get("teamId") ?? "";

  const [team, setTeam] = useState<Team | null>(null);
  const [allPlayers, setAllPlayers] = useState<PlayerWithStats[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draftRosterSlots, setDraftRosterSlots] = useState<TeamRosterSlot[]>([]);
  const [selectedFormation, setSelectedFormation] = useState<StartingFormation | "">("");
  const [captainPlayerId, setCaptainPlayerId] = useState("");
  const [viceCaptainPlayerId, setViceCaptainPlayerId] = useState("");

  const [nameQuery, setNameQuery] = useState("");
  const [positionFilter, setPositionFilter] = useState<PlayerPosition | "">("");
  const [clubFilter, setClubFilter] = useState("");
  const [maxPriceFilter, setMaxPriceFilter] = useState("");

  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [isConfirmingSave, setIsConfirmingSave] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const currentGameweek = useCurrentGameweek();

  useEffect(() => {
    if (!teamId) {
      setLoadError("No team specified — open the Squad Builder from your league page.");
      return;
    }
    Promise.all([
      authedFetch(`${getApiBaseUrl()}/teams/${teamId}`).then((response) => response.json()),
      authedFetch(`${getApiBaseUrl()}/players`).then((response) => response.json()),
    ])
      .then(([loadedTeam, players]: [Team, PlayerWithStats[]]) => {
        if (!loadedTeam?.rosterSlots) {
          setLoadError("Could not load this team — check the link and try again.");
          return;
        }
        setTeam(loadedTeam);
        setAllPlayers(players);
        setDraftRosterSlots(loadedTeam.rosterSlots);
        setSelectedFormation(loadedTeam.formation ?? "");
        setCaptainPlayerId(loadedTeam.captainPlayerId ?? "");
        setViceCaptainPlayerId(loadedTeam.viceCaptainPlayerId ?? "");
      })
      .catch(() => setLoadError("Could not load the squad builder — try refreshing."));
  }, [teamId]);

  const playersById = useMemo(() => new Map(allPlayers.map((player) => [player.id, player])), [allPlayers]);

  const draftSquadPlayers = useMemo(
    () =>
      draftRosterSlots
        .map((slot) => {
          const player = playersById.get(slot.playerId);
          return player ? { player, isStarting: slot.isStarting } : null;
        })
        .filter((entry): entry is { player: PlayerWithStats; isStarting: boolean } => entry !== null),
    [draftRosterSlots, playersById],
  );

  const totalSpentInMillions = draftSquadPlayers.reduce((sum, { player }) => sum + player.priceInMillions, 0);
  const remainingBudgetInMillions = STARTING_SQUAD_BUDGET_IN_MILLIONS - totalSpentInMillions;
  const goalkeeperCount = draftSquadPlayers.filter(({ player }) => player.position === "GK").length;
  const countsByClub = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { player } of draftSquadPlayers) counts.set(player.club, (counts.get(player.club) ?? 0) + 1);
    return counts;
  }, [draftSquadPlayers]);

  const starters = draftSquadPlayers.filter((entry) => entry.isStarting);
  const bench = draftSquadPlayers.filter((entry) => !entry.isStarting);
  const startingCountsByPosition = useMemo(() => {
    const counts: Record<PlayerPosition, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const { player } of starters) counts[player.position]++;
    return counts;
  }, [starters]);
  const formationRequirement = selectedFormation ? formationRequiredCounts(selectedFormation) : null;

  const clubs = useMemo(() => [...new Set(allPlayers.map((player) => player.club))].sort(), [allPlayers]);

  const matchesThisGameweek: Match[] = useMemo(() => {
    const gameweek = currentGameweek?.gameweek;
    if (!gameweek) return [];
    return currentGameweek.matches.map((match) => ({
      id: match.id,
      externalId: null,
      gameweekId: gameweek.id,
      homeClub: match.homeClub,
      awayClub: match.awayClub,
      kickoffAt: new Date(match.kickoffAt),
      status: match.status,
      finalHomeScore: match.finalHomeScore,
      finalAwayScore: match.finalAwayScore,
    }));
  }, [currentGameweek]);

  /** Same per-club kickoff locking the API enforces on save — surfaced here so users see a
   * Locked badge before they hit "changes touching locked players" save warnings. */
  function isPlayerLocked(player: PlayerWithStats): boolean {
    return isClubLocked(player.club, matchesThisGameweek, new Date());
  }

  function lockedSinceLabel(player: PlayerWithStats): string | undefined {
    const clubMatch = matchesThisGameweek.find(
      (match) => match.homeClub === player.club || match.awayClub === player.club,
    );
    return clubMatch ? `Locked — match kicked off ${formatDayAndTime(clubMatch.kickoffAt)}` : undefined;
  }

  const filteredPlayers = useMemo(() => {
    return allPlayers.filter((player) => {
      if (nameQuery && !player.name.toLowerCase().includes(nameQuery.toLowerCase())) return false;
      if (positionFilter && player.position !== positionFilter) return false;
      if (clubFilter && player.club !== clubFilter) return false;
      if (maxPriceFilter && player.priceInMillions > Number(maxPriceFilter)) return false;
      return true;
    });
  }, [allPlayers, nameQuery, positionFilter, clubFilter, maxPriceFilter]);

  function addPlayerError(player: PlayerWithStats): string | null {
    if (draftRosterSlots.some((slot) => slot.playerId === player.id)) return null;
    if (draftRosterSlots.length >= SQUAD_SIZE) return `Squad is full (${SQUAD_SIZE}/${SQUAD_SIZE})`;
    if (player.position === "GK" && goalkeeperCount >= REQUIRED_GOALKEEPER_COUNT) {
      return `Squad already has ${REQUIRED_GOALKEEPER_COUNT} goalkeepers`;
    }
    if ((countsByClub.get(player.club) ?? 0) >= MAX_PLAYERS_PER_CLUB) {
      return `Squad already has ${MAX_PLAYERS_PER_CLUB} players from ${player.club}`;
    }
    if (player.priceInMillions > remainingBudgetInMillions) {
      return `£${player.priceInMillions}M exceeds remaining budget (£${remainingBudgetInMillions}M)`;
    }
    return null;
  }

  /** Any edit to the draft invalidates both the last save's feedback and a pending confirmation
   * summary — the summary must always describe exactly what "Confirm save" would submit. */
  function clearSaveFeedback() {
    setSaveResult(null);
    setIsConfirmingSave(false);
  }

  function handleAddPlayer(player: PlayerWithStats) {
    clearSaveFeedback();
    if (addPlayerError(player)) return;
    setDraftRosterSlots((slots) => [...slots, { playerId: player.id, isStarting: false }]);
  }

  function handleRemovePlayer(playerId: string) {
    clearSaveFeedback();
    setDraftRosterSlots((slots) => slots.filter((slot) => slot.playerId !== playerId));
    if (captainPlayerId === playerId) setCaptainPlayerId("");
    if (viceCaptainPlayerId === playerId) setViceCaptainPlayerId("");
  }

  function toggleStartingError(player: PlayerWithStats): string | null {
    if (!formationRequirement) return "Pick a formation first";
    const required = formationRequirement[player.position];
    if (startingCountsByPosition[player.position] >= required) {
      return `${selectedFormation} only starts ${required} ${player.position}`;
    }
    return null;
  }

  function handleToggleStarting(playerId: string, makeStarting: boolean) {
    clearSaveFeedback();
    if (makeStarting) {
      const player = playersById.get(playerId);
      if (!player || toggleStartingError(player)) return;
    }
    setDraftRosterSlots((slots) =>
      slots.map((slot) => (slot.playerId === playerId ? { ...slot, isStarting: makeStarting } : slot)),
    );
  }

  /** Switching formation keeps every starter who still fits the new shape's per-position counts
   * (demoting the latest-added overflow to the bench) instead of clearing the whole lineup —
   * changing strategy shouldn't mean rebuilding the starting XI from scratch. */
  function handleFormationChange(formation: StartingFormation | "") {
    clearSaveFeedback();
    setSelectedFormation(formation);
    if (!formation) return;

    const requiredCounts = formationRequiredCounts(formation);
    const keptStarterCounts: Record<PlayerPosition, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    const updatedSlots = draftRosterSlots.map((slot) => {
      if (!slot.isStarting) return slot;
      const player = playersById.get(slot.playerId);
      if (!player) return { ...slot, isStarting: false };
      if (keptStarterCounts[player.position] < requiredCounts[player.position]) {
        keptStarterCounts[player.position]++;
        return slot;
      }
      return { ...slot, isStarting: false };
    });
    setDraftRosterSlots(updatedSlots);

    const stillStartingPlayerIds = new Set(updatedSlots.filter((slot) => slot.isStarting).map((slot) => slot.playerId));
    if (captainPlayerId && !stillStartingPlayerIds.has(captainPlayerId)) setCaptainPlayerId("");
    if (viceCaptainPlayerId && !stillStartingPlayerIds.has(viceCaptainPlayerId)) setViceCaptainPlayerId("");
  }

  /** Step one of saving: run every client-side validation, then show the confirmation summary
   * instead of submitting straight away — accidental saves of a half-finished squad were a
   * smoke-test finding. The actual submit happens in handleConfirmedSave. */
  function handleRequestSave() {
    setSaveResult(null);

    const squadError = validateSquadComposition(draftSquadPlayers.map(({ player }) => player));
    if (squadError) {
      setSaveResult({ kind: "error", messages: [squadError] });
      return;
    }
    if (!selectedFormation) {
      setSaveResult({ kind: "error", messages: ["Pick a formation first."] });
      return;
    }
    if (deriveStartingFormation(starters.map(({ player }) => player)) !== selectedFormation) {
      setSaveResult({ kind: "error", messages: [`Starting XI must fill every ${selectedFormation} slot before saving.`] });
      return;
    }
    if (!captainPlayerId || !viceCaptainPlayerId) {
      setSaveResult({ kind: "error", messages: ["Pick a captain and vice-captain."] });
      return;
    }
    if (captainPlayerId === viceCaptainPlayerId) {
      setSaveResult({ kind: "error", messages: ["Captain and vice-captain must be different players."] });
      return;
    }

    setIsConfirmingSave(true);
  }

  /** Saves the roster then the lineup — sequential because setTeamLineup derives the formation
   * from whatever roster is already persisted, so the roster save must land first. */
  async function handleConfirmedSave() {
    setIsConfirmingSave(false);
    setIsSaving(true);
    try {
      const rosterResponse = await authedFetch(`${getApiBaseUrl()}/teams/${teamId}/roster`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rosterSlots: draftRosterSlots }),
      });
      const rosterBody = await rosterResponse.json();
      if (!rosterResponse.ok) {
        setSaveResult({ kind: "error", messages: [rosterBody.message ?? "Could not save squad."] });
        return;
      }

      const lineupResponse = await authedFetch(`${getApiBaseUrl()}/teams/${teamId}/lineup`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ formation: selectedFormation, captainPlayerId, viceCaptainPlayerId }),
      });
      const lineupBody = await lineupResponse.json();
      if (!lineupResponse.ok) {
        setTeam(rosterBody);
        setSaveResult({
          kind: "error",
          messages: [`Squad saved, but lineup failed: ${lineupBody.message ?? "unknown error"}`],
        });
        return;
      }

      setTeam(lineupBody);
      const lockedChangeWarnings: string[] = [
        ...(rosterBody.lockedChangeWarnings ?? []),
        ...(lineupBody.lockedChangeWarnings ?? []),
      ];
      if (lockedChangeWarnings.length > 0) {
        // A partial apply means the server kept locked players' current values — resync the
        // draft to what was actually saved so the screen doesn't show the skipped changes.
        setDraftRosterSlots(lineupBody.rosterSlots);
        setSelectedFormation(lineupBody.formation ?? "");
        setCaptainPlayerId(lineupBody.captainPlayerId ?? "");
        setViceCaptainPlayerId(lineupBody.viceCaptainPlayerId ?? "");
        setSaveResult({ kind: "partial", messages: lockedChangeWarnings });
      } else {
        setSaveResult({ kind: "success", messages: ["Squad and lineup saved."] });
      }
    } finally {
      setIsSaving(false);
    }
  }

  if (loadError) return <main><p className="msg msg-error">{loadError}</p></main>;
  if (!team) return <LoadingState label="Loading your squad…" />;

  return (
    <main>
      <p style={{ marginBottom: "0.35rem" }}>
        <Link href={`/leagues?leagueId=${team.leagueId}`}>← Back to league</Link>
      </p>
      <h1>Squad Builder — {team.name}</h1>

      <GameweekBanner current={currentGameweek} />

      <div className="stat-row">
        <div className="stat-tile">
          <span className="stat-tile-label">Budget remaining</span>
          <span className="stat-tile-value">£{remainingBudgetInMillions.toFixed(1)}M</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Squad</span>
          <span className="stat-tile-value">{draftRosterSlots.length}/{SQUAD_SIZE}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-tile-label">Goalkeepers</span>
          <span className="stat-tile-value">{goalkeeperCount}/{REQUIRED_GOALKEEPER_COUNT}</span>
        </div>
      </div>

      <div className="discovery-header">
        <h2>Player Discovery</h2>
        <span className="budget-chip">£{remainingBudgetInMillions.toFixed(1)}M left</span>
      </div>
      <p>
        All available players this season. Pick {SQUAD_SIZE}: {REQUIRED_GOALKEEPER_COUNT} goalkeepers +{" "}
        {SQUAD_SIZE - REQUIRED_GOALKEEPER_COUNT} outfield, max {MAX_PLAYERS_PER_CLUB} per club, within £
        {STARTING_SQUAD_BUDGET_IN_MILLIONS}M.
      </p>
      <div className="filter-row">
        <input placeholder="Search by name" value={nameQuery} onChange={(event) => setNameQuery(event.target.value)} />
        <select value={positionFilter} onChange={(event) => setPositionFilter(event.target.value as PlayerPosition | "")}>
          <option value="">All positions</option>
          {ALL_POSITIONS.map((position) => (
            <option key={position} value={position}>{position}</option>
          ))}
        </select>
        <select value={clubFilter} onChange={(event) => setClubFilter(event.target.value)}>
          <option value="">All clubs</option>
          {clubs.map((club) => (
            <option key={club} value={club}>{club}</option>
          ))}
        </select>
        <input
          type="number"
          placeholder="Max price (£M)"
          value={maxPriceFilter}
          onChange={(event) => setMaxPriceFilter(event.target.value)}
        />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Club</th>
              <th>Pos</th>
              <th>Price</th>
              <th>Pts</th>
              <th>Form</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filteredPlayers.map((player) => {
              const inSquad = draftRosterSlots.some((slot) => slot.playerId === player.id);
              const blockedReason = inSquad ? null : addPlayerError(player);
              return (
                <tr key={player.id}>
                  <td>
                    {player.name}{" "}
                    {isPlayerLocked(player) && (
                      <span className="badge badge-red" title={lockedSinceLabel(player)}>Locked</span>
                    )}{" "}
                    <AvailabilityBadge status={player.availabilityStatus} reason={player.availabilityReason} />
                  </td>
                  <td>{player.club}</td>
                  <td>{player.position}</td>
                  <td>£{player.priceInMillions}M</td>
                  <td>{player.totalFantasyPoints}</td>
                  <td style={{ color: "var(--color-text-muted)", fontSize: "0.8rem" }}>{describeRecentForm(player)}</td>
                  <td>
                    {inSquad ? (
                      <button onClick={() => handleRemovePlayer(player.id)}>Remove</button>
                    ) : (
                      <button
                        className={!blockedReason ? "btn-primary" : ""}
                        onClick={() => handleAddPlayer(player)}
                        disabled={!!blockedReason}
                        title={blockedReason ?? ""}
                      >
                        Add
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Formation</h2>
      <p>
        Formation numbers are DEF-MID-FWD for your starting XI — every formation also starts exactly 1
        goalkeeper. Changing formation keeps starters that still fit the new shape.
      </p>
      <select
        value={selectedFormation}
        onChange={(event) => handleFormationChange(event.target.value as StartingFormation | "")}
        style={{ maxWidth: 200 }}
      >
        <option value="">Choose a formation</option>
        {VALID_STARTING_FORMATIONS.map((formation) => (
          <option key={formation} value={formation}>{formation}</option>
        ))}
      </select>
      {formationRequirement && (
        <p className="formation-status">
          GK {startingCountsByPosition.GK}/{formationRequirement.GK} · DEF{" "}
          {startingCountsByPosition.DEF}/{formationRequirement.DEF} · MID {startingCountsByPosition.MID}/
          {formationRequirement.MID} · FWD {startingCountsByPosition.FWD}/{formationRequirement.FWD}
        </p>
      )}

      <h2>Starting XI</h2>
      <ul className="squad-list">
        {starters.map(({ player }) => (
          <li key={player.id}>
            <PlayerNameTapTarget playerId={player.id} playerName={player.name} />
            <span className="badge">{player.position}</span>
            {isPlayerLocked(player) && (
              <span className="badge badge-red" title={lockedSinceLabel(player)}>Locked</span>
            )}
            <AvailabilityBadge status={player.availabilityStatus} reason={player.availabilityReason} />
            <button style={{ marginLeft: "auto" }} onClick={() => handleToggleStarting(player.id, false)}>
              → Bench
            </button>
          </li>
        ))}
      </ul>

      <h2>Bench</h2>
      <ul className="squad-list">
        {bench.map(({ player }) => {
          const blockedReason = toggleStartingError(player);
          return (
            <li key={player.id}>
              <PlayerNameTapTarget playerId={player.id} playerName={player.name} />
              <span className="badge">{player.position}</span>
              {isPlayerLocked(player) && (
                <span className="badge badge-red" title={lockedSinceLabel(player)}>Locked</span>
              )}
              <AvailabilityBadge status={player.availabilityStatus} reason={player.availabilityReason} />
              <button
                style={{ marginLeft: "auto" }}
                onClick={() => handleToggleStarting(player.id, true)}
                disabled={!!blockedReason}
                title={blockedReason ?? ""}
              >
                → Starting
              </button>
            </li>
          );
        })}
      </ul>

      <h2>Captaincy</h2>
      <p>Your captain scores double points. If they don't play, your vice-captain scores double instead.</p>
      <div className="captaincy-row">
        <label>
          Captain
          <select
            value={captainPlayerId}
            onChange={(event) => {
              clearSaveFeedback();
              setCaptainPlayerId(event.target.value);
            }}
          >
            <option value="">Choose captain</option>
            {starters.map(({ player }) => (
              <option key={player.id} value={player.id}>{player.name}</option>
            ))}
          </select>
        </label>
        <label>
          Vice-Captain
          <select
            value={viceCaptainPlayerId}
            onChange={(event) => {
              clearSaveFeedback();
              setViceCaptainPlayerId(event.target.value);
            }}
          >
            <option value="">Choose vice-captain</option>
            {starters.map(({ player }) => (
              <option key={player.id} value={player.id}>{player.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 480 }}>
        {!isConfirmingSave && (
          <button className="btn-primary" onClick={handleRequestSave} disabled={isSaving} style={{ maxWidth: 200 }}>
            Save squad
          </button>
        )}

        {isConfirmingSave && (
          <div className="card">
            <strong>Confirm your squad</strong>
            <ul style={{ margin: "0.5rem 0 0.75rem" }}>
              <li>
                {draftRosterSlots.length}/{SQUAD_SIZE} players — £{totalSpentInMillions.toFixed(1)}M of £
                {STARTING_SQUAD_BUDGET_IN_MILLIONS}M
              </li>
              <li>Formation: {selectedFormation}</li>
              <li>Captain: {playersById.get(captainPlayerId)?.name ?? "—"}</li>
              <li>Vice-captain: {playersById.get(viceCaptainPlayerId)?.name ?? "—"}</li>
            </ul>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="btn-primary" onClick={handleConfirmedSave} disabled={isSaving}>
                Confirm save
              </button>
              <button onClick={() => setIsConfirmingSave(false)} disabled={isSaving}>
                Keep editing
              </button>
            </div>
          </div>
        )}

        {saveResult?.kind === "success" && (
          <div className="msg msg-success">
            <p style={{ margin: 0, color: "inherit" }}>{saveResult.messages.join(" ")}</p>
            <div className="link-list" style={{ marginTop: "0.5rem" }}>
              <Link href={`/leagues?leagueId=${team.leagueId}`}>Back to league</Link>
              <Link href={`/teams/transfers?teamId=${team.id}`}>Transfers</Link>
            </div>
          </div>
        )}

        {saveResult?.kind === "partial" && (
          <div className="msg msg-warning">
            <p style={{ margin: 0, color: "inherit" }}>
              Saved — but these changes were skipped because players are locked:
            </p>
            <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", listStyle: "disc" }}>
              {saveResult.messages.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        {saveResult?.kind === "error" && (
          <p className="msg msg-error">{saveResult.messages.join(" ")}</p>
        )}
      </div>
    </main>
  );
}
