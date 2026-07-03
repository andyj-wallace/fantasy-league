"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { authedFetch } from "@/app/lib/apiFetch";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { PlayerNameTapTarget } from "../../components/PlayerNameTapTarget";
import {
  formationRequiredCounts,
  MAX_PLAYERS_PER_CLUB,
  REQUIRED_GOALKEEPER_COUNT,
  SQUAD_SIZE,
  STARTING_SQUAD_BUDGET_IN_MILLIONS,
  VALID_STARTING_FORMATIONS,
  deriveStartingFormation,
  validateSquadComposition,
  type PlayerPosition,
  type PlayerWithStats,
  type StartingFormation,
  type Team,
  type TeamRosterSlot,
} from "../../../domain";

const ALL_POSITIONS: PlayerPosition[] = ["GK", "DEF", "MID", "FWD"];

function describeRecentForm(player: PlayerWithStats): string {
  if (!player.recentFormPoints) return "Insufficient Data";
  return player.recentFormPoints.join(", ");
}

/** The team is addressed by a ?teamId= query param rather than a path segment because the
 * frontend deploys as a static export (see "Deployment (AWS)" in the architecture doc) — runtime
 * UUIDs can't be enumerated as static paths at build time. The Suspense boundary is required for
 * useSearchParams under static prerendering. */
export default function SquadBuilderPage() {
  return (
    <Suspense fallback={null}>
      <SquadBuilderPageContent />
    </Suspense>
  );
}

function SquadBuilderPageContent() {
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

  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

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

  function handleAddPlayer(player: PlayerWithStats) {
    setSaveMessage(null);
    if (addPlayerError(player)) return;
    setDraftRosterSlots((slots) => [...slots, { playerId: player.id, isStarting: false }]);
  }

  function handleRemovePlayer(playerId: string) {
    setSaveMessage(null);
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
    setSaveMessage(null);
    if (makeStarting) {
      const player = playersById.get(playerId);
      if (!player || toggleStartingError(player)) return;
    }
    setDraftRosterSlots((slots) =>
      slots.map((slot) => (slot.playerId === playerId ? { ...slot, isStarting: makeStarting } : slot)),
    );
  }

  function handleFormationChange(formation: StartingFormation | "") {
    setSaveMessage(null);
    setSelectedFormation(formation);
    setDraftRosterSlots((slots) => slots.map((slot) => ({ ...slot, isStarting: false })));
    setCaptainPlayerId("");
    setViceCaptainPlayerId("");
  }

  /** Saves the roster then the lineup in one click — sequential because setTeamLineup derives
   * the formation from whatever roster is already persisted, so the roster save must land first. */
  async function handleSave() {
    setSaveMessage(null);

    const squadError = validateSquadComposition(draftSquadPlayers.map(({ player }) => player));
    if (squadError) {
      setSaveMessage(squadError);
      return;
    }
    if (!selectedFormation) {
      setSaveMessage("Pick a formation first.");
      return;
    }
    if (deriveStartingFormation(starters.map(({ player }) => player)) !== selectedFormation) {
      setSaveMessage(`Starting XI must fill every ${selectedFormation} slot before saving.`);
      return;
    }
    if (!captainPlayerId || !viceCaptainPlayerId) {
      setSaveMessage("Pick a captain and vice-captain.");
      return;
    }
    if (captainPlayerId === viceCaptainPlayerId) {
      setSaveMessage("Captain and vice-captain must be different players.");
      return;
    }

    setIsSaving(true);
    try {
      const rosterResponse = await authedFetch(`${getApiBaseUrl()}/teams/${teamId}/roster`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rosterSlots: draftRosterSlots }),
      });
      const rosterBody = await rosterResponse.json();
      if (!rosterResponse.ok) {
        setSaveMessage(rosterBody.message ?? "Could not save squad.");
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
        setSaveMessage(`Squad saved, but lineup failed: ${lineupBody.message ?? "unknown error"}`);
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
        setSaveMessage(`Squad and lineup saved, except locked players: ${lockedChangeWarnings.join("; ")}`);
      } else {
        setSaveMessage("Squad and lineup saved.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  if (loadError) return <main><p className="msg msg-error">{loadError}</p></main>;
  if (!team) return null;

  return (
    <main>
      <h1>Squad Builder — {team.name}</h1>

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

      <h2>Player Discovery</h2>
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
                  <td>{player.name}</td>
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
      <div className="captaincy-row">
        <label>
          Captain
          <select value={captainPlayerId} onChange={(event) => setCaptainPlayerId(event.target.value)}>
            <option value="">Choose captain</option>
            {starters.map(({ player }) => (
              <option key={player.id} value={player.id}>{player.name}</option>
            ))}
          </select>
        </label>
        <label>
          Vice-Captain
          <select value={viceCaptainPlayerId} onChange={(event) => setViceCaptainPlayerId(event.target.value)}>
            <option value="">Choose vice-captain</option>
            {starters.map(({ player }) => (
              <option key={player.id} value={player.id}>{player.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 200 }}>
        <button className="btn-primary" onClick={handleSave} disabled={isSaving}>
          Save squad
        </button>
        {saveMessage && (
          <p className={`msg ${saveMessage.includes("saved") ? "msg-success" : "msg-error"}`}>
            {saveMessage}
          </p>
        )}
      </div>
    </main>
  );
}
