import { playersRepository } from "../db/repositories";
import type { PlayerAvailabilityStatus } from "../domain";
import type { FootballDataProvider } from "./footballDataProvider";

/** Provider's `type` field only has two values — see Fantasy League Architecture.txt's
 * "Player Availability Status" section. Anything unrecognized is treated as AVAILABLE rather
 * than guessed at. */
function mapInjuryTypeToAvailabilityStatus(type: string): PlayerAvailabilityStatus {
  if (type === "Missing Fixture") return "OUT";
  if (type === "Questionable") return "QUESTIONABLE";
  return "AVAILABLE";
}

/** Syncs availabilityStatus/availabilityReason from the provider's injuries endpoint. The
 * endpoint is absence-only, so anyone not in this pull is reset back to AVAILABLE. */
export async function importPlayerAvailability(provider: FootballDataProvider): Promise<void> {
  const injuries = await provider.fetchInjuries();

  for (const injury of injuries) {
    const player = await playersRepository.findByExternalId(injury.externalPlayerId);
    if (!player) continue;
    await playersRepository.setAvailability(player.id, mapInjuryTypeToAvailabilityStatus(injury.type), injury.reason);
  }

  await playersRepository.resetAvailabilityExceptExternalIds(injuries.map((injury) => injury.externalPlayerId));
}
