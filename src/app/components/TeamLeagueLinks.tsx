import Link from "next/link";
import type { League } from "../../domain";

interface TeamSummary {
  id: string;
  name: string;
  remainingBudgetInMillions: number;
}

/** The team/league summary line shown wherever a user's team needs quick links to its squad
 * and transfers, plus a link to the league page (which carries that league's Standings) — the
 * home page's multi-league list and the single-league page both render this. */
export function TeamLeagueLinks({ team, league }: { team: TeamSummary; league: League }) {
  return (
    <>
      <Link href={`/leagues?leagueId=${league.id}`}>{league.name}</Link> — {team.name} (£{team.remainingBudgetInMillions}M
      remaining) — <Link href={`/teams/squad-builder?teamId=${team.id}`}>Squad</Link>{" "}
      <Link href={`/teams/transfers?teamId=${team.id}`}>Transfers</Link>
    </>
  );
}
