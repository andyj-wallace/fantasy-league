import { teamsRepository } from "../../../db/repositories";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

export const getAvailableTransfers: ApiHandler = async (event) => {
  const teamId = event.pathParameters?.teamId ?? "";
  const team = await teamsRepository.findById(teamId);
  if (!team) return notFoundResponse();
  return jsonResponse(200, { bankedFreeTransferCount: team.bankedFreeTransferCount });
};
