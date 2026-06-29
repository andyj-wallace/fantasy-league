import { playersRepository } from "../../../db/repositories";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";
import { attachPlayerStats } from "./attachPlayerStats";

export const getPlayer: ApiHandler = async (event) => {
  const playerId = event.pathParameters?.playerId ?? "";
  const player = await playersRepository.findById(playerId);
  if (!player) return notFoundResponse();
  const [playerWithStats] = await attachPlayerStats([player]);
  return jsonResponse(200, playerWithStats);
};
