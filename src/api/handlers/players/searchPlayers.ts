import { playersRepository } from "../../../db/repositories";
import type { PlayerPosition } from "../../../domain";
import { requireAuth } from "../../auth";
import { jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";
import { attachPlayerStats } from "./attachPlayerStats";

export const searchPlayers: ApiHandler = requireAuth(async (event, _session) => {
  const query = event.queryStringParameters ?? {};
  const players = await playersRepository.findMany({
    club: query.club,
    position: query.position as PlayerPosition | undefined,
  });
  return jsonResponse(200, await attachPlayerStats(players));
});
