import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";

export default async function PlayerDetailPage({
  params,
}: {
  params: Promise<{ playerId: string }>;
}) {
  const { playerId } = await params;
  const response = await fetch(`${getApiBaseUrl()}/players/${playerId}`, { cache: "no-store" });
  const player = await response.json();

  return (
    <main>
      <h1>Player Detail</h1>
      <pre>{JSON.stringify(player, null, 2)}</pre>
    </main>
  );
}
