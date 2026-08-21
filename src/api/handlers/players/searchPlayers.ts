import { playersRepository } from "../../../db/repositories";
import type { PlayerPosition } from "../../../domain";
import { requireAuth } from "../../auth";
import { jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";
import { attachPlayerStats } from "./attachPlayerStats";

export const searchPlayers: ApiHandler = requireAuth(async (event, _session) => {
  const query = event.queryStringParameters ?? {};

  // Explicit by-id lookup, deliberately exempt from the current-season-squad filter below: a
  // manager keeps holding a player whose club leaves the league until they transfer him out, so
  // the squad builder must still be able to resolve names/prices for roster slots that player
  // discovery no longer offers. Kept as its own parameter (rather than an id filter layered onto
  // the search) so callers get exactly the players they asked for and nothing else.
  const requestedPlayerIds = (query.playerIds ?? "").split(",").filter((playerId) => playerId !== "");
  if (requestedPlayerIds.length > 0) {
    const playersByIds = await playersRepository.findManyByIds(requestedPlayerIds);
    return jsonResponse(200, await attachPlayerStats(playersByIds));
  }

  const players = await playersRepository.findMany({
    club: query.club,
    position: query.position as PlayerPosition | undefined,
    // Player discovery only ever offers players currently in the league — a relegated club's
    // squad stays in the table for historic scores but must not be pickable.
    onlyInCurrentSeasonSquad: true,
  });
  return jsonResponse(200, await attachPlayerStats(players));
});
