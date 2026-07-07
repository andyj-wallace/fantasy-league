import Link from "next/link";
import { SQUAD_SIZE, type League } from "../../domain";

interface TeamSummary {
  id: string;
  name: string;
  remainingBudgetInMillions: number;
}

/** "Is this team ready to score points?" at a glance: squad still short of 16, lineup (formation
 * + captaincy) not saved yet, or all set. Renders nothing when the caller didn't load the state. */
function SquadStatusBadge({ rosterCount, isLineupSet }: { rosterCount?: number; isLineupSet?: boolean }) {
  if (rosterCount === undefined) return null;
  if (rosterCount < SQUAD_SIZE) {
    return <span className="badge badge-red">Squad incomplete ({rosterCount}/{SQUAD_SIZE})</span>;
  }
  if (isLineupSet === false) return <span className="badge badge-red">Lineup not set</span>;
  return <span className="badge badge-green">Ready</span>;
}

/** The team/league summary line shown wherever a user's team needs quick links to its squad
 * and transfers, plus a link to the league page (which carries that league's Standings) — the
 * home page's multi-league list and the single-league page both render this.
 * When `onOpenTransfers` is supplied (the league hub does), Transfers opens in-place as an overlay
 * instead of navigating away; without it (the home page's list) Transfers stays a plain link. */
export function TeamLeagueLinks({
  team,
  league,
  rosterCount,
  isLineupSet,
  onOpenTransfers,
}: {
  team: TeamSummary;
  league: League;
  rosterCount?: number;
  isLineupSet?: boolean;
  onOpenTransfers?: (teamId: string) => void;
}) {
  return (
    <>
      <Link href={`/leagues?leagueId=${league.id}`}>{league.name}</Link> — {team.name} (£{team.remainingBudgetInMillions}M
      remaining) <SquadStatusBadge rosterCount={rosterCount} isLineupSet={isLineupSet} /> —{" "}
      <Link href={`/teams/squad-builder?teamId=${team.id}`}>Squad</Link> |{" "}
      {onOpenTransfers ? (
        <button type="button" className="btn-link" onClick={() => onOpenTransfers(team.id)}>
          Transfers
        </button>
      ) : (
        <Link href={`/teams/transfers?teamId=${team.id}`}>Transfers</Link>
      )}
    </>
  );
}
