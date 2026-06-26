import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";

export default async function LeaderboardPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const { leagueId } = await params;
  const response = await fetch(`${getApiBaseUrl()}/leagues/${leagueId}/standings`, {
    cache: "no-store",
  });
  const standings = await response.json();

  return (
    <main>
      <h1>Leaderboard</h1>
      <pre>{JSON.stringify(standings, null, 2)}</pre>
    </main>
  );
}
