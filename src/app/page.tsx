import Link from "next/link";

const mockLeagueId = "00000000-0000-0000-0000-000000000010";
const mockTeamId = "00000000-0000-0000-0000-000000000040";
const mockPlayerId = "00000000-0000-0000-0000-000000000030";

export default function HomePage() {
  return (
    <main>
      <h1>Fantasy League</h1>
      <ul>
        <li>
          <Link href="/login">Login</Link>
        </li>
        <li>
          <Link href="/leagues/create">Create League</Link>
        </li>
        <li>
          <Link href="/leagues/join">Join League</Link>
        </li>
        <li>
          <Link href={`/teams/${mockTeamId}/squad-builder`}>Squad Builder</Link>
        </li>
        <li>
          <Link href={`/teams/${mockTeamId}/transfers`}>Transfers</Link>
        </li>
        <li>
          <Link href={`/leagues/${mockLeagueId}/leaderboard`}>Leaderboard</Link>
        </li>
        <li>
          <Link href={`/players/${mockPlayerId}`}>Player Detail</Link>
        </li>
      </ul>
    </main>
  );
}
