import { playersRepository } from "../../../db/repositories";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const getPlayer: ApiHandler = async (event) => {
  const playerId = event.pathParameters?.playerId ?? "";
  const player = await playersRepository.findById(playerId);
  if (!player) return notFoundResponse();
  return jsonResponse(200, player);
};
