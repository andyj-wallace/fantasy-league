import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import type { Player, Team } from "../../../../domain";

export default async function SquadBuilderPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const [teamResponse, playersResponse] = await Promise.all([
    fetch(`${getApiBaseUrl()}/teams/${teamId}`, { cache: "no-store" }),
    fetch(`${getApiBaseUrl()}/players`, { cache: "no-store" }),
  ]);

  if (!teamResponse.ok) {
    return (
      <main>
        <h1>Squad Builder</h1>
        <p>Could not load this team.</p>
      </main>
    );
  }

  const team: Team = await teamResponse.json();
  const players: Player[] = await playersResponse.json();
  const playersById = new Map(players.map((player) => [player.id, player]));

  const starters = team.rosterSlots.filter((slot) => slot.isStarting);
  const bench = team.rosterSlots.filter((slot) => !slot.isStarting);

  function describePlayer(playerId: string): string {
    const player = playersById.get(playerId);
    if (!player) return playerId;
    const tags = [
      playerId === team.captainPlayerId ? "C" : null,
      playerId === team.viceCaptainPlayerId ? "VC" : null,
    ].filter(Boolean);
    const tagSuffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
    return `${player.name} — ${player.position}, ${player.club}, £${player.priceInMillions}M${tagSuffix}`;
  }

  return (
    <main>
      <h1>Squad Builder — {team.name}</h1>
      <p>Budget remaining: £{team.remainingBudgetInMillions}M</p>
      <p>Banked free transfers: {team.bankedFreeTransferCount}</p>
      <p>Formation: {team.formation ?? "Not set yet"}</p>

      {team.rosterSlots.length === 0 && <p>No roster set yet — use the API to submit your 16-man squad.</p>}

      {starters.length > 0 && (
        <>
          <h2>Starting XI</h2>
          <ul>
            {starters.map((slot) => (
              <li key={slot.playerId}>{describePlayer(slot.playerId)}</li>
            ))}
          </ul>
        </>
      )}

      {bench.length > 0 && (
        <>
          <h2>Bench</h2>
          <ul>
            {bench.map((slot) => (
              <li key={slot.playerId}>{describePlayer(slot.playerId)}</li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
