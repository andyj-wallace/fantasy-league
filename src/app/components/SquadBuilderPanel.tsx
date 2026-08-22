"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { authedFetch } from "@/app/lib/apiFetch";
import { API_CACHE_TTL_MS, getCachedJson, invalidateCached } from "@/app/lib/apiCache";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { PlayerNameTapTarget } from "@/app/components/PlayerNameTapTarget";
import { AvailabilityBadge } from "@/app/components/AvailabilityBadge";
import { LockedBadge } from "@/app/components/LockedBadge";
import { LoadingState } from "@/app/components/LoadingState";
import { FormationPitch } from "@/app/components/FormationPitch";
import { RecentFormBars } from "@/app/components/RecentFormBars";
import { StatTile } from "@/app/components/StatTile";
import { useCurrentGameweekContext } from "@/app/lib/gameweekContext";
import { SquadGameweekSummary } from "./SquadGameweekSummary";
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
  summarizeGameweekMatchProgress,
  validateSquadComposition,
  type Match,
  type PlayerPosition,
  type PlayerGameweekPoints,
  type PlayerWithStats,
  type StartingFormation,
  type Team,
  type TeamRosterSlot,
} from "../../domain";

const ALL_POSITIONS: PlayerPosition[] = ["GK", "DEF", "MID", "FWD"];
const PLAYERS_PER_PAGE = 15;

/** Add/remove action, Name, Club, Pos, Price, Pts, Form — the span a blocked-reason note row needs
 * to cover so it reads as a continuation of the player row above it. */
const DISCOVERY_TABLE_COLUMN_COUNT = 7;

/** The one blocked reason that is a property of the whole squad rather than of the player in the
 * row it appears under. It applies to every addable player at once, so it is stated once above the
 * table instead of repeating identically under all fifteen rows on the page. */
const SQUAD_IS_FULL_REASON = `Squad is full (${SQUAD_SIZE}/${SQUAD_SIZE})`;

/** Ids for the two hoisted notices, so every row they cover can point `aria-describedby` at them. */
const SQUAD_FULL_NOTICE_ID = "discovery-squad-full-notice";
const BENCH_FORMATION_NOTICE_ID = "bench-formation-notice";

/** Discovery-table columns the user can sort by, each mapped to the comparable value it sorts on.
 * Position sorts in on-pitch order (GK→FWD) rather than alphabetically. Form sorts by the most
 * recent points value, with "Insufficient Data" (null) always sorting last. */
type SortableColumn = "name" | "club" | "position" | "price" | "points" | "form";

const POSITION_SORT_ORDER: Record<PlayerPosition, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

function playerSortValue(player: PlayerWithStats, column: SortableColumn): string | number {
  switch (column) {
    case "name":
      return player.name.toLowerCase();
    case "club":
      return player.club.toLowerCase();
    case "position":
      return POSITION_SORT_ORDER[player.position];
    case "price":
      return player.priceInMillions;
    case "points":
      return player.totalFantasyPoints;
    case "form":
      return player.recentFormPoints?.[0] ?? Number.NEGATIVE_INFINITY;
  }
}

/** A discovery-table column header that sorts the table on click, showing an arrow for the
 * currently-active sort column and its direction. */
function SortableHeader({
  label,
  column,
  activeColumn,
  direction,
  onSort,
  className,
}: {
  label: string;
  column: SortableColumn;
  activeColumn: SortableColumn;
  direction: "asc" | "desc";
  onSort: (column: SortableColumn) => void;
  className?: string;
}) {
  const isActive = column === activeColumn;
  return (
    <th className={className}>
      <button
        type="button"
        className={`sortable-header ${isActive ? "is-active" : ""}`}
        onClick={() => onSort(column)}
        aria-sort={isActive ? (direction === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        <span className="sortable-header-arrow">{isActive ? (direction === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

/** In-progress edits (roster changes, formation, captaincy) mirrored to sessionStorage so they
 * survive the panel unmounting — navigating to a player's detail page and back on the standalone
 * page, or the hub closing/reopening the overlay — which would otherwise silently drop everything
 * not yet saved to the server. Cleared once a save actually lands, so a later fresh visit reflects
 * server state rather than a stale mirror. */
interface StoredSquadDraft {
  rosterSlots: TeamRosterSlot[];
  formation: StartingFormation | "";
  captainPlayerId: string;
  viceCaptainPlayerId: string;
}

function squadDraftStorageKey(teamId: string): string {
  return `squad-builder-draft:${teamId}`;
}

function readStoredSquadDraft(teamId: string): StoredSquadDraft | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(squadDraftStorageKey(teamId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSquadDraft;
  } catch {
    return null;
  }
}

function writeStoredSquadDraft(teamId: string, draft: StoredSquadDraft): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(squadDraftStorageKey(teamId), JSON.stringify(draft));
}

function clearStoredSquadDraft(teamId: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(squadDraftStorageKey(teamId));
}

/**
 * One player in the Starting XI or Bench list: a flat line of text — position, name, availability —
 * ending in a text link that moves them to the other list. Deliberately not a card with a bordered
 * button: the two lists run 16 rows deep and are mostly read on phones, where per-row chrome costs
 * more vertical space than it earns.
 *
 * `blockedReason` disables the link and prints the reason as its own line under the row rather than
 * beside it, so an explanation never widens or stretches the row.
 */
function LineupPlayerRow({
  player,
  gameweekNumber,
  gameweekPoints,
  isLocked,
  toggleLabel,
  blockedReason,
  hoistedReasonElementId,
  onRemove,
  removeBlockedReason,
  onToggle,
}: {
  player: PlayerWithStats;
  /** The gameweek whose points this row shows, or null when no gameweek is in play yet — in which
   * case the points cell renders empty rather than a misleading zero. */
  gameweekNumber: number | null;
  /** Null when the player has no scored match in that gameweek: no fixture, or theirs hasn't
   * finished. Deliberately distinct from a present entry worth 0 points. */
  gameweekPoints: PlayerGameweekPoints | null;
  /** Faded row treatment, for a player whose club has already kicked off. A row can be blocked
   * without being locked (a bench player the formation has no starting slot for), which reads as
   * an ordinary disabled link rather than a fade. */
  isLocked: boolean;
  toggleLabel: "Bench" | "Start";
  blockedReason: string | null;
  /** Non-null when the player can't leave the squad (their match has kicked off); the reason is
   * shown on hover and read out, matching how the discovery table explains the same block. */
  removeBlockedReason: string | null;
  onRemove: () => void;
  /** When the whole list shares one blocked reason, the row points its screen-reader description
   * at that single hoisted element and prints no note of its own. */
  hoistedReasonElementId?: string;
  onToggle: () => void;
}) {
  const ownReasonElementId = `lineup-note-${player.id}`;
  const describedById = hoistedReasonElementId ?? (blockedReason ? ownReasonElementId : undefined);
  const printsOwnReasonNote = blockedReason !== null && hoistedReasonElementId === undefined;
  return (
    <li className={isLocked ? "lineup-list-item-locked" : undefined}>
      <span className="lineup-position">{player.position}</span>
      <PlayerNameTapTarget playerId={player.id} playerName={player.name} />
      <AvailabilityBadge status={player.availabilityStatus} reason={player.availabilityReason} />
      <span
        className="lineup-gameweek-points"
        role={gameweekNumber === null ? undefined : "img"}
        aria-label={
          gameweekNumber === null
            ? undefined
            : gameweekPoints
              ? `Gameweek ${gameweekNumber}: ${gameweekPoints.totalPoints} points`
              : `Gameweek ${gameweekNumber}: not scored yet`
        }
      >
        {gameweekNumber === null ? "" : gameweekPoints ? gameweekPoints.totalPoints : "—"}
      </span>
      <button
        type="button"
        className="btn-link lineup-toggle"
        onClick={onToggle}
        disabled={blockedReason !== null}
        title={blockedReason ?? ""}
        aria-describedby={describedById}
      >
        {toggleLabel}
      </button>
      <button
        type="button"
        className="lineup-remove"
        onClick={onRemove}
        disabled={removeBlockedReason !== null}
        title={removeBlockedReason ?? `Remove ${player.name} from squad`}
        aria-label={`Remove ${player.name} from squad`}
      >
        &times;
      </button>
      {printsOwnReasonNote && (
        <span className="lineup-row-note" id={ownReasonElementId}>
          {blockedReason}
        </span>
      )}
    </li>
  );
}

/**
 * Player discovery (`GET /players`) only lists players still in a current Premier League squad, but
 * a manager keeps holding a player whose club has left the league until they transfer him out.
 * Without this backfill those roster slots resolve to nothing and the player silently disappears
 * from the manager's own Starting XI — taking their price out of the budget total and letting a
 * 15-man roster be saved over a 16-man one.
 *
 * Costs no extra request in the normal case: the follow-up by-id lookup only fires when a roster
 * slot is actually missing from the discovery list.
 */
async function withRosterPlayersMissingFromDiscovery(
  discoveryPlayers: PlayerWithStats[],
  rosterSlots: TeamRosterSlot[],
): Promise<PlayerWithStats[]> {
  const discoveredPlayerIds = new Set(discoveryPlayers.map((player) => player.id));
  const missingPlayerIds = rosterSlots
    .map((slot) => slot.playerId)
    .filter((playerId) => !discoveredPlayerIds.has(playerId));
  if (missingPlayerIds.length === 0) return discoveryPlayers;

  const missingPlayers = await getCachedJson<PlayerWithStats[]>(
    `${getApiBaseUrl()}/players?playerIds=${missingPlayerIds.join(",")}`,
    API_CACHE_TTL_MS.PLAYER_DATA,
  ).catch(() => [] as PlayerWithStats[]);
  return [...discoveryPlayers, ...missingPlayers];
}

/** Save feedback in three distinct shapes: full success, partial apply (the server skipped
 * changes to locked players and returned lockedChangeWarnings), and outright rejection. Kept
 * structured rather than as one string so partial saves can't be misread as clean successes. */
interface SaveResult {
  kind: "success" | "partial" | "error";
  messages: string[];
}

/** The squad-building surface (budget, formation, lineup, captaincy, player discovery, save) as
 * pure content with no page chrome, so it renders inside the league hub's slide-up overlay or as
 * the standalone /teams/squad-builder page. Fetches its own data and owns the whole draft/save
 * lifecycle. `onChanged` fires after a successful save so the host can refresh dependent views
 * (the league's squad-status badge and remaining budget). */
export function SquadBuilderPanel({ teamId, onChanged }: { teamId: string; onChanged?: () => void }) {
  /** Null until the manager opens or closes the player picker themselves; see isPlayerPickerExpanded. */
  const [isPlayerPickerOpen, setIsPlayerPickerOpen] = useState<boolean | null>(null);
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
  const [sortColumn, setSortColumn] = useState<SortableColumn>("points");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = useState(1);

  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [isConfirmingSave, setIsConfirmingSave] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const currentGameweek = useCurrentGameweekContext();
  /** The gameweek the points column and summary report on. Null while the context is loading, or
   * before any gameweek exists — both render as an empty cell rather than a zero. */
  const currentGameweekNumber = currentGameweek?.gameweek?.number ?? null;
  const gameweekMatchProgress = useMemo(
    () => summarizeGameweekMatchProgress(currentGameweek?.matches ?? []),
    [currentGameweek],
  );
  const gameweekPointsOf = (player: PlayerWithStats): PlayerGameweekPoints | null =>
    currentGameweekNumber === null ? null : (player.pointsByGameweekNumber[currentGameweekNumber] ?? null);

  useEffect(() => {
    if (!teamId) {
      setLoadError("No team specified — open the Squad Builder from your league page.");
      return;
    }
    Promise.all([
      getCachedJson<Team>(`${getApiBaseUrl()}/teams/${teamId}`, API_CACHE_TTL_MS.SHORT),
      getCachedJson<PlayerWithStats[]>(`${getApiBaseUrl()}/players`, API_CACHE_TTL_MS.PLAYER_DATA),
    ])
      .then(async ([loadedTeam, players]) => {
        if (!loadedTeam?.rosterSlots) {
          setLoadError("Could not load this team — check the link and try again.");
          return;
        }
        setTeam(loadedTeam);

        const storedDraft = readStoredSquadDraft(teamId);
        const rosterSlots = storedDraft ? storedDraft.rosterSlots : loadedTeam.rosterSlots;
        setAllPlayers(await withRosterPlayersMissingFromDiscovery(players, rosterSlots));

        if (storedDraft) {
          setDraftRosterSlots(storedDraft.rosterSlots);
          setSelectedFormation(storedDraft.formation);
          setCaptainPlayerId(storedDraft.captainPlayerId);
          // A draft saved before captain/vice-captain became mutually exclusive (or a team saved
          // that way server-side) can name the same player twice — drop the vice-captaincy rather
          // than render a value the vice-captain list no longer offers.
          setViceCaptainPlayerId(
            storedDraft.viceCaptainPlayerId === storedDraft.captainPlayerId ? "" : storedDraft.viceCaptainPlayerId,
          );
        } else {
          setDraftRosterSlots(loadedTeam.rosterSlots);
          setSelectedFormation(loadedTeam.formation ?? "4-4-2");
          setCaptainPlayerId(loadedTeam.captainPlayerId ?? "");
          setViceCaptainPlayerId(
            loadedTeam.viceCaptainPlayerId === loadedTeam.captainPlayerId
              ? ""
              : (loadedTeam.viceCaptainPlayerId ?? ""),
          );
        }
      })
      .catch(() => setLoadError("Could not load the squad builder — try refreshing."));
  }, [teamId]);

  // Mirrors the draft to sessionStorage on every edit — gated on `team` so this can't fire (and
  // overwrite a real draft with blanks) before the load effect above has run.
  useEffect(() => {
    if (!team) return;
    writeStoredSquadDraft(teamId, {
      rosterSlots: draftRosterSlots,
      formation: selectedFormation,
      captainPlayerId,
      viceCaptainPlayerId,
    });
  }, [team, teamId, draftRosterSlots, selectedFormation, captainPlayerId, viceCaptainPlayerId]);

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

  /** The fewest outfield players of each position any valid formation can field, derived from the
   * formation list rather than restated — 3 DEF, 2 MID, 1 FWD today. A 16-man squad holding fewer
   * than this of any position can never put out a legal XI, no matter how it is arranged. */
  const fewestStartersAnyFormationNeeds = useMemo(() => {
    const outfieldPositions = ["DEF", "MID", "FWD"] as const;
    const fewest = { DEF: Infinity, MID: Infinity, FWD: Infinity };
    for (const formation of VALID_STARTING_FORMATIONS) {
      const required = formationRequiredCounts(formation);
      for (const position of outfieldPositions) {
        fewest[position] = Math.min(fewest[position], required[position]);
      }
    }
    return fewest;
  }, []);

  /** What the squad is still missing before it could field any legal XI, and whether enough empty
   * slots remain to fix it. Surfaced while picking, because the alternative is spending the whole
   * £110M and only being told at save time that the squad is unfieldable. */
  const unfieldableSquadWarning = useMemo(() => {
    const shortfalls = (["DEF", "MID", "FWD"] as const)
      .map((position) => ({
        position,
        stillNeeded:
          fewestStartersAnyFormationNeeds[position] -
          draftSquadPlayers.filter(({ player }) => player.position === position).length,
      }))
      .filter((shortfall) => shortfall.stillNeeded > 0);
    if (shortfalls.length === 0) return null;

    const shortfallList = shortfalls
      .map((shortfall) => `${shortfall.stillNeeded} ${shortfall.position}`)
      .join(", ");
    const totalStillNeeded = shortfalls.reduce((sum, shortfall) => sum + shortfall.stillNeeded, 0);
    const emptySlotCount = SQUAD_SIZE - draftRosterSlots.length;

    return totalStillNeeded > emptySlotCount
      ? {
          isBlocking: true,
          message: `This squad can't field a legal XI: it still needs ${shortfallList}, but only ${emptySlotCount} ${emptySlotCount === 1 ? "slot is" : "slots are"} free. Remove someone to make room.`,
        }
      : {
          isBlocking: false,
          message: `Every formation starts at least 3 DEF, 2 MID and 1 FWD — you still need ${shortfallList}.`,
        };
  }, [draftSquadPlayers, draftRosterSlots.length, fewestStartersAnyFormationNeeds]);
  const countsByClub = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { player } of draftSquadPlayers) counts.set(player.club, (counts.get(player.club) ?? 0) + 1);
    return counts;
  }, [draftSquadPlayers]);

  const starters = draftSquadPlayers.filter((entry) => entry.isStarting);
  const bench = draftSquadPlayers.filter((entry) => !entry.isStarting);
  const squadIsFull = draftRosterSlots.length >= SQUAD_SIZE;
  /** Null means "follow the squad": picking players is the task while the squad is short, and is
   * not once it's complete. Any explicit open/close by the manager pins it and wins from then on,
   * so the section never collapses out from under someone who opened it. */
  const isPlayerPickerExpanded = isPlayerPickerOpen ?? !squadIsFull;
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

  const sortedPlayers = useMemo(() => {
    const directionMultiplier = sortDirection === "asc" ? 1 : -1;
    return [...filteredPlayers].sort((firstPlayer, secondPlayer) => {
      const firstValue = playerSortValue(firstPlayer, sortColumn);
      const secondValue = playerSortValue(secondPlayer, sortColumn);
      if (firstValue < secondValue) return -1 * directionMultiplier;
      if (firstValue > secondValue) return 1 * directionMultiplier;
      // Stable, predictable tiebreak so equal sort values don't shuffle between renders.
      return firstPlayer.name.localeCompare(secondPlayer.name);
    });
  }, [filteredPlayers, sortColumn, sortDirection]);

  /** Clicking a column sorts ascending the first time, then toggles direction on repeat clicks.
   * Numeric/points columns default to descending (highest first) since that's what users scan for. */
  function handleSortColumn(column: SortableColumn) {
    if (column === sortColumn) {
      setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection(column === "name" || column === "club" || column === "position" ? "asc" : "desc");
    }
    setCurrentPage(1);
  }

  // A filter or sort change can shift the result set out from under whatever page the user was on.
  useEffect(() => {
    setCurrentPage(1);
  }, [nameQuery, positionFilter, clubFilter, maxPriceFilter]);

  const totalPages = Math.max(1, Math.ceil(sortedPlayers.length / PLAYERS_PER_PAGE));
  // Clamp rather than trust state directly: a filter can shrink totalPages below whatever
  // page the reset effect hasn't caught up to yet on this render.
  const clampedPage = Math.min(currentPage, totalPages);
  const pageStartIndex = (clampedPage - 1) * PLAYERS_PER_PAGE;
  const paginatedPlayers = useMemo(
    () => sortedPlayers.slice(pageStartIndex, pageStartIndex + PLAYERS_PER_PAGE),
    [sortedPlayers, pageStartIndex],
  );

  /** Why this player's squad membership can't be changed right now, or null if it can. Covers both
   * directions: a locked player can neither be added nor removed (the same rule setTeamRoster
   * enforces on save), and an unlocked player outside the squad is checked against the squad-size,
   * goalkeeper, per-club and budget limits. */
  function squadChangeBlockedReason(player: PlayerWithStats): string | null {
    if (isPlayerLocked(player)) return lockedSinceLabel(player) ?? "Locked";
    if (draftRosterSlots.some((slot) => slot.playerId === player.id)) return null;
    if (draftRosterSlots.length >= SQUAD_SIZE) return SQUAD_IS_FULL_REASON;
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

  function handleSetCaptain(playerId: string) {
    clearSaveFeedback();
    setCaptainPlayerId(playerId);
  }

  function handleSetViceCaptain(playerId: string) {
    clearSaveFeedback();
    setViceCaptainPlayerId(playerId);
  }

  /** Starters one of the two captaincy dropdowns may offer: everyone except whoever already holds
   * the other armband. Captain and vice-captain must be different players (the save path rejects a
   * squad where they aren't), so offering the same name in both lists only invites a rejection. */
  function startersEligibleForCaptaincy(playerIdHoldingOtherArmband: string): PlayerWithStats[] {
    return starters
      .map(({ player }) => player)
      .filter((player) => player.id !== playerIdHoldingOtherArmband);
  }

  /** Whether the selected formation still has room for another starter at this position, given
   * who's already starting. Drives both auto-placement on add and the manual bench/starting toggle. */
  function hasOpenStartingSlot(position: PlayerPosition): boolean {
    return formationRequirement !== null && startingCountsByPosition[position] < formationRequirement[position];
  }

  function handleAddPlayer(player: PlayerWithStats) {
    clearSaveFeedback();
    if (squadChangeBlockedReason(player)) return;
    setDraftRosterSlots((slots) => [
      ...slots,
      { playerId: player.id, isStarting: hasOpenStartingSlot(player.position) },
    ]);
  }

  function handleRemovePlayer(playerId: string) {
    // Removing a player is the start of a swap, so the picker opens and stays open from here on
    // rather than collapsing again the instant the squad is back to 16.
    setIsPlayerPickerOpen(true);
    clearSaveFeedback();
    const player = playersById.get(playerId);
    if (player && squadChangeBlockedReason(player)) return;
    setDraftRosterSlots((slots) => slots.filter((slot) => slot.playerId !== playerId));
    if (captainPlayerId === playerId) setCaptainPlayerId("");
    if (viceCaptainPlayerId === playerId) setViceCaptainPlayerId("");
  }

  function toggleStartingError(player: PlayerWithStats): string | null {
    if (!formationRequirement) return "Pick a formation first";
    if (!hasOpenStartingSlot(player.position)) {
      return `${selectedFormation} only starts ${formationRequirement[player.position]} ${player.position}`;
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
      // The roster PUT has landed server-side even if the lineup PUT below fails, so invalidate
      // now rather than only on full success — otherwise a stale roster/budget could still be
      // served from cache after a partial save.
      invalidateCached(`${getApiBaseUrl()}/teams/${teamId}`);
      invalidateCached(`${getApiBaseUrl()}/me/teams`);

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
      clearStoredSquadDraft(teamId);
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
      onChanged?.();
    } finally {
      setIsSaving(false);
    }
  }

  /** True only when no bench player can be promoted at all, which is the ordinary state of a
   * complete squad — the XI is exactly full, so every position is closed. When only some
   * positions are closed the rows keep their individual reasons, because they differ. */
  const everyBenchPlayerIsBlockedByFormation =
    bench.length > 0 &&
    bench.every(({ player }) => isPlayerLocked(player) || toggleStartingError(player) !== null);

  if (loadError) return <p className="msg msg-error">{loadError}</p>;
  if (!team) return <LoadingState label="Loading your squad…" />;

  return (
    <>
      <p className="player-detail-meta" style={{ marginBottom: "1rem" }}>
        {team.name}
      </p>

      <div className="stat-row">
        <StatTile
          label={remainingBudgetInMillions < 0 ? "Over budget" : "Budget remaining"}
          value={`£${remainingBudgetInMillions.toFixed(1)}M`}
          valueStyle={remainingBudgetInMillions < 0 ? { color: "var(--color-error-text)" } : undefined}
        />
        <StatTile label="Squad" value={`${draftRosterSlots.length}/${SQUAD_SIZE}`} />
        <StatTile label="Goalkeepers" value={`${goalkeeperCount}/${REQUIRED_GOALKEEPER_COUNT}`} />
      </div>

      {unfieldableSquadWarning && (
        <p className={unfieldableSquadWarning.isBlocking ? "msg msg-error" : "list-notice"}>
          {unfieldableSquadWarning.message}
        </p>
      )}

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

      <h2>Lineup</h2>

      <div className="builder-layout">
        <div className="builder-layout-captaincy">
          <h3>Captaincy</h3>
          <p>Your captain scores double points. If they don't play, your vice-captain scores double instead.</p>
          <div className="captaincy-row">
            <label>
              Captain
              <select value={captainPlayerId} onChange={(event) => handleSetCaptain(event.target.value)}>
                <option value="">Choose captain</option>
                {startersEligibleForCaptaincy(viceCaptainPlayerId).map((player) => (
                  <option key={player.id} value={player.id} disabled={isPlayerLocked(player)}>
                    {player.name}{isPlayerLocked(player) ? " (Locked)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Vice-Captain
              <select value={viceCaptainPlayerId} onChange={(event) => handleSetViceCaptain(event.target.value)}>
                <option value="">Choose vice-captain</option>
                {startersEligibleForCaptaincy(captainPlayerId).map((player) => (
                  <option key={player.id} value={player.id} disabled={isPlayerLocked(player)}>
                    {player.name}{isPlayerLocked(player) ? " (Locked)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="builder-layout-pitch">
          <FormationPitch
            formation={selectedFormation || null}
            starters={starters.map(({ player }) => player)}
            captainPlayerId={captainPlayerId}
            viceCaptainPlayerId={viceCaptainPlayerId}
          />
        </div>

        <div className="builder-layout-list">
          <h3>Starting XI</h3>
          <ul className="lineup-list">
            {starters.map(({ player }) => {
              const locked = isPlayerLocked(player);
              return (
                <LineupPlayerRow
                  key={player.id}
                  player={player}
                  gameweekNumber={currentGameweekNumber}
                  gameweekPoints={gameweekPointsOf(player)}
                  isLocked={locked}
                  toggleLabel="Bench"
                  blockedReason={locked ? (lockedSinceLabel(player) ?? "Locked") : null}
                  removeBlockedReason={locked ? (lockedSinceLabel(player) ?? "Locked") : null}
                  onRemove={() => handleRemovePlayer(player.id)}
                  onToggle={() => handleToggleStarting(player.id, false)}
                />
              );
            })}
          </ul>

          <h3>Bench</h3>
          {everyBenchPlayerIsBlockedByFormation && (
            <p className="list-notice" id={BENCH_FORMATION_NOTICE_ID}>
              Your {selectedFormation} XI is full. Bench a starter to promote someone.
            </p>
          )}
          <ul className="lineup-list lineup-list--bench">
            {bench.map(({ player }) => {
              const locked = isPlayerLocked(player);
              return (
                <LineupPlayerRow
                  key={player.id}
                  player={player}
                  gameweekNumber={currentGameweekNumber}
                  gameweekPoints={gameweekPointsOf(player)}
                  isLocked={locked}
                  toggleLabel="Start"
                  blockedReason={locked ? (lockedSinceLabel(player) ?? "Locked") : toggleStartingError(player)}
                  hoistedReasonElementId={
                    everyBenchPlayerIsBlockedByFormation && !locked ? BENCH_FORMATION_NOTICE_ID : undefined
                  }
                  removeBlockedReason={locked ? (lockedSinceLabel(player) ?? "Locked") : null}
                  onRemove={() => handleRemovePlayer(player.id)}
                  onToggle={() => handleToggleStarting(player.id, true)}
                />
              );
            })}
          </ul>

          {currentGameweekNumber !== null && (
            <SquadGameweekSummary
              gameweekNumber={currentGameweekNumber}
              squadPlayers={draftSquadPlayers.map(({ player }) => player)}
              captainPlayerId={captainPlayerId}
              viceCaptainPlayerId={viceCaptainPlayerId}
              matchProgress={gameweekMatchProgress}
            />
          )}
        </div>
      </div>

      <details
        className="discovery-section"
        open={isPlayerPickerExpanded}
        onToggle={(event) => setIsPlayerPickerOpen(event.currentTarget.open)}
      >
      <summary className="discovery-header">
        <h2>{squadIsFull ? "Change players" : "Add players"}</h2>
        <span className="budget-chip">
          {draftRosterSlots.length}/{SQUAD_SIZE} · £{remainingBudgetInMillions.toFixed(1)}M left
        </span>
      </summary>
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

      {squadIsFull && (
        <p className="list-notice" id={SQUAD_FULL_NOTICE_ID}>
          {SQUAD_IS_FULL_REASON}. Remove a player to make room for another.
        </p>
      )}

      <div className="table-wrap">
        <table className="discovery-table">
          <thead>
            <tr>
              <th className="col-action"></th>
              <SortableHeader label="Name" column="name" activeColumn={sortColumn} direction={sortDirection} onSort={handleSortColumn} />
              <SortableHeader label="Club" column="club" activeColumn={sortColumn} direction={sortDirection} onSort={handleSortColumn} />
              <SortableHeader label="Pos" column="position" activeColumn={sortColumn} direction={sortDirection} onSort={handleSortColumn} className="col-narrow" />
              <SortableHeader label="Price" column="price" activeColumn={sortColumn} direction={sortDirection} onSort={handleSortColumn} className="col-narrow" />
              <SortableHeader label="Pts" column="points" activeColumn={sortColumn} direction={sortDirection} onSort={handleSortColumn} className="col-narrow" />
              <SortableHeader label="Form" column="form" activeColumn={sortColumn} direction={sortDirection} onSort={handleSortColumn} className="col-narrow" />
            </tr>
          </thead>
          <tbody>
            {paginatedPlayers.map((player) => {
              const inSquad = draftRosterSlots.some((slot) => slot.playerId === player.id);
              const locked = isPlayerLocked(player);
              const blockedReason = squadChangeBlockedReason(player);
              const ownNoteElementId = `discovery-note-${player.id}`;
              const reasonIsHoisted = blockedReason === SQUAD_IS_FULL_REASON;
              const blockedReasonElementId = reasonIsHoisted ? SQUAD_FULL_NOTICE_ID : ownNoteElementId;
              const printsOwnNote = blockedReason !== null && !reasonIsHoisted;
              return (
                <Fragment key={player.id}>
                  <tr
                    className={[locked ? "row-locked" : "", printsOwnNote ? "has-row-note" : ""]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <td className="col-action">
                      {inSquad ? (
                        <button
                          onClick={() => handleRemovePlayer(player.id)}
                          disabled={blockedReason !== null}
                          aria-label={`Remove ${player.name} from squad`}
                          aria-describedby={blockedReason ? blockedReasonElementId : undefined}
                          title={blockedReason ?? "Remove"}
                        >
                          &minus;
                        </button>
                      ) : (
                        <button
                          className={!blockedReason ? "btn-primary" : ""}
                          onClick={() => handleAddPlayer(player)}
                          disabled={blockedReason !== null}
                          aria-label={`Add ${player.name} to squad`}
                          aria-describedby={blockedReason ? blockedReasonElementId : undefined}
                          title={blockedReason ?? "Add"}
                        >
                          +
                        </button>
                      )}
                    </td>
                    <td>
                      <PlayerNameTapTarget playerId={player.id} playerName={player.name} />{" "}
                      {locked && <LockedBadge contextLabel={lockedSinceLabel(player)} />}{" "}
                      <AvailabilityBadge status={player.availabilityStatus} reason={player.availabilityReason} />
                    </td>
                    <td>{player.club}</td>
                    <td className="col-narrow">{player.position}</td>
                    <td className="col-narrow">£{player.priceInMillions}M</td>
                    <td className="col-narrow">{player.totalFantasyPoints}</td>
                    <td className="col-narrow"><RecentFormBars points={player.recentFormPoints} /></td>
                  </tr>
                  {/* The reason sits on its own full-width line under the player rather than inside
                      the narrow leading action column, where a full sentence wrapped to three or
                      four lines and stretched the row with it. */}
                  {printsOwnNote && (
                    <tr className={locked ? "discovery-row-note row-locked" : "discovery-row-note"}>
                      <td colSpan={DISCOVERY_TABLE_COLUMN_COUNT} id={ownNoteElementId}>
                        {blockedReason}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pagination-row">
        <button onClick={() => setCurrentPage((page) => page - 1)} disabled={clampedPage <= 1}>
          Prev
        </button>
        <span>
          {filteredPlayers.length === 0
            ? "No players match these filters"
            : `Page ${clampedPage} of ${totalPages} · Showing ${pageStartIndex + 1}–${Math.min(pageStartIndex + PLAYERS_PER_PAGE, filteredPlayers.length)} of ${filteredPlayers.length} players`}
        </span>
        <button onClick={() => setCurrentPage((page) => page + 1)} disabled={clampedPage >= totalPages}>
          Next
        </button>
      </div>
      </details>

      <div className="save-bar">
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

        {saveResult?.kind === "error" && <p className="msg msg-error">{saveResult.messages.join(" ")}</p>}
      </div>
    </>
  );
}
