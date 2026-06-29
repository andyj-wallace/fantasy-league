import { playersRepository } from "../../../db/repositories";
import type { PlayerPosition } from "../../../domain";
import { jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";
import { attachPlayerStats } from "./attachPlayerStats";

export const searchPlayers: ApiHandler = async (event) => {
  const query = event.queryStringParameters ?? {};
  const players = await playersRepository.findMany({
    club: query.club,
    position: query.position as PlayerPosition | undefined,
  });
  return jsonResponse(200, await attachPlayerStats(players));
};
