"use client";

import { useEffect, useMemo, useState } from "react";
import { API_CACHE_TTL_MS, getCachedJson } from "@/app/lib/apiCache";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { PlayerNameTapTarget } from "@/app/components/PlayerNameTapTarget";
import { AvailabilityBadge } from "@/app/components/AvailabilityBadge";
import { LoadingState } from "@/app/components/LoadingState";
import { FormationPitch } from "@/app/components/FormationPitch";
import { SquadGameweekSummary } from "@/app/components/SquadGameweekSummary";
import { formatDayAndTime } from "@/app/lib/formatDate";
import { useCurrentGameweekContext } from "@/app/lib/gameweekContext";
import {
  summarizeGameweekMatchProgress,
  type PlayerGameweekPoints,
  type PlayerWithStats,
  type StartingFormation,
  type TeamRosterSlot,
} from "@/domain";

interface LeagueTeamSquadResponse {
  team: {
    id: string;
    leagueId: string;
    name: string;
    formation: StartingFormation | null;
    captainPlayerId: string | null;
    viceCaptainPlayerId: string | null;
    remainingBudgetInMillions: number;
    bankedFreeTransferCount: number;
  };
  managerName: string;
  isViewersOwnTeam: boolean;
  isSquadVisible: boolean;
  revealsAt: string | null;
  rosterSlots: TeamRosterSlot[];
  gameweekNumber: number | null;
  gameweekTotalPoints: number | null;
  transferPointsCostThisGameweek: number;
  paidTransferCountThisGameweek: number;
}

/** One player in the read-only Starting XI / Bench list — the squad builder's own lineup row,
 * minus every editing control (no bench/start toggle, no remove). Adds a C/V armband marker next
 * to the name, since there's no captaincy control section here to convey it another way. */
function RivalLineupPlayerRow({
  player,
  gameweekNumber,
  gameweekPoints,
  captainPlayerId,
  viceCaptainPlayerId,
}: {
  player: PlayerWithStats;
  /** The gameweek whose points this row shows, or null when no gameweek is in play yet. */
  gameweekNumber: number | null;
  gameweekPoints: PlayerGameweekPoints | null;
  captainPlayerId: string | null;
  viceCaptainPlayerId: string | null;
}) {
  return (
    <li>
      <span className="lineup-position">{player.position}</span>
      <PlayerNameTapTarget playerId={player.id} playerName={player.name} />
      {player.id === captainPlayerId && <span className="lineup-armband">C</span>}
      {player.id === viceCaptainPlayerId && <span className="lineup-armband">V</span>}
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
    </li>
  );
}

/** The read-only "pitch + team sheet" view of another manager's team: the same layout
 * SquadBuilderPanel renders for the viewer's own squad, minus every editing control. Fetches
 * GET /leagues/:leagueId/teams/:teamId, which itself decides — via resolveRivalSquadVisibility —
 * whether the roster is revealed yet; this component only renders whatever that response says.
 * Never imports authedFetch: there is nothing here a viewer can mutate. */
export function RivalSquadPanel({ leagueId, teamId }: { leagueId: string; teamId: string }) {
  const [squad, setSquad] = useState<LeagueTeamSquadResponse | null>(null);
  const [players, setPlayers] = useState<PlayerWithStats[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const currentGameweek = useCurrentGameweekContext();
  const gameweekMatchProgress = useMemo(
    () => summarizeGameweekMatchProgress(currentGameweek?.matches ?? []),
    [currentGameweek],
  );

  useEffect(() => {
    let isCancelled = false;
    setSquad(null);
    setPlayers([]);
    setLoadError(null);

    getCachedJson<LeagueTeamSquadResponse>(`${getApiBaseUrl()}/leagues/${leagueId}/teams/${teamId}`, API_CACHE_TTL_MS.SHORT)
      .then(async (loadedSquad) => {
        // Fetched (and only set into state) before the squad itself, so a visible squad never
        // renders its lists for a beat with no players resolved yet.
        const loadedPlayers =
          loadedSquad.isSquadVisible && loadedSquad.rosterSlots.length > 0
            ? await getCachedJson<PlayerWithStats[]>(
                `${getApiBaseUrl()}/players?playerIds=${loadedSquad.rosterSlots.map((slot) => slot.playerId).join(",")}`,
                API_CACHE_TTL_MS.PLAYER_DATA,
              )
            : [];
        if (isCancelled) return;
        setPlayers(loadedPlayers);
        setSquad(loadedSquad);
      })
      .catch(() => {
        if (!isCancelled) setLoadError("Could not load this squad — try refreshing.");
      });

    return () => {
      isCancelled = true;
    };
  }, [leagueId, teamId]);

  if (loadError) return <p className="msg msg-error">{loadError}</p>;
  if (!squad) return <LoadingState label="Loading squad…" />;

  if (!squad.isSquadVisible) {
    return (
      <p className="msg msg-info">
        {squad.revealsAt
          ? `Squads stay hidden until the Gameweek ${squad.gameweekNumber} deadline — ${formatDayAndTime(squad.revealsAt)}. Come back then to see what ${squad.managerName} picked.`
          : "Squads are revealed once the first gameweek's deadline passes."}
      </p>
    );
  }

  if (squad.rosterSlots.length === 0) {
    return <p className="msg msg-info">{squad.managerName} hasn't picked a squad yet.</p>;
  }

  const playersById = new Map(players.map((player) => [player.id, player]));
  const gameweekPointsOf = (player: PlayerWithStats): PlayerGameweekPoints | null =>
    squad.gameweekNumber === null ? null : (player.pointsByGameweekNumber[squad.gameweekNumber] ?? null);

  const starters = squad.rosterSlots
    .filter((slot) => slot.isStarting)
    .map((slot) => playersById.get(slot.playerId))
    .filter((player): player is PlayerWithStats => player !== undefined);
  const bench = squad.rosterSlots
    .filter((slot) => !slot.isStarting)
    .map((slot) => playersById.get(slot.playerId))
    .filter((player): player is PlayerWithStats => player !== undefined);

  return (
    <>
      <p className="player-detail-meta" style={{ marginBottom: "0.25rem" }}>
        {squad.team.name} · {squad.managerName}
        {squad.gameweekNumber !== null && squad.gameweekTotalPoints !== null
          ? ` · Gameweek ${squad.gameweekNumber}: ${squad.gameweekTotalPoints} pts`
          : ""}
      </p>
      <p style={{ fontSize: "0.8rem", marginBottom: "1rem" }}>
        £{squad.team.remainingBudgetInMillions.toFixed(1)}M remaining · {squad.team.bankedFreeTransferCount} banked
        transfer{squad.team.bankedFreeTransferCount === 1 ? "" : "s"}
      </p>

      <FormationPitch
        formation={squad.team.formation}
        starters={starters}
        captainPlayerId={squad.team.captainPlayerId}
        viceCaptainPlayerId={squad.team.viceCaptainPlayerId}
      />

      <h3>Starting XI</h3>
      <ul className="lineup-list">
        {starters.map((player) => (
          <RivalLineupPlayerRow
            key={player.id}
            player={player}
            gameweekNumber={squad.gameweekNumber}
            gameweekPoints={gameweekPointsOf(player)}
            captainPlayerId={squad.team.captainPlayerId}
            viceCaptainPlayerId={squad.team.viceCaptainPlayerId}
          />
        ))}
      </ul>

      <h3>Bench</h3>
      <ul className="lineup-list lineup-list--bench">
        {bench.map((player) => (
          <RivalLineupPlayerRow
            key={player.id}
            player={player}
            gameweekNumber={squad.gameweekNumber}
            gameweekPoints={gameweekPointsOf(player)}
            captainPlayerId={squad.team.captainPlayerId}
            viceCaptainPlayerId={squad.team.viceCaptainPlayerId}
          />
        ))}
      </ul>

      {squad.gameweekNumber !== null && (
        <SquadGameweekSummary
          gameweekNumber={squad.gameweekNumber}
          squadPlayers={[...starters, ...bench]}
          captainPlayerId={squad.team.captainPlayerId ?? ""}
          viceCaptainPlayerId={squad.team.viceCaptainPlayerId ?? ""}
          matchProgress={gameweekMatchProgress}
          transferPointsCost={squad.transferPointsCostThisGameweek}
          paidTransferCount={squad.paidTransferCountThisGameweek}
          squadPossessiveLabel={`${squad.managerName}'s`}
        />
      )}
    </>
  );
}
