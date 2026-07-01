import { playersRepository } from "../../../db/repositories";
import { createFootballDataProviderFromEnv } from "../../../workers/apiFootballProvider";
import { jsonResponse, notFoundResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";
import { attachPlayerStats } from "./attachPlayerStats";

/** Matches createFootballDataProviderFromEnv's own default — the season the profile/season-stats
 * lookups below are scoped to when FOOTBALL_DATA_SEASON_YEAR isn't set. */
const DEFAULT_SEASON_YEAR = 2024;

export const getPlayer: ApiHandler = async (event) => {
  const playerId = event.pathParameters?.playerId ?? "";
  const player = await playersRepository.findById(playerId);
  if (!player) return notFoundResponse();
  const [playerWithStats] = await attachPlayerStats([player]);

  if (!player.externalId) {
    return jsonResponse(200, { ...playerWithStats, profile: null, seasonStatistics: null });
  }

  const seasonYear = Number(process.env.FOOTBALL_DATA_SEASON_YEAR ?? DEFAULT_SEASON_YEAR);
  let profile = null;
  let seasonStatistics = null;
  try {
    const footballDataProvider = createFootballDataProviderFromEnv();
    [profile, seasonStatistics] = await Promise.all([
      footballDataProvider.fetchPlayerProfile(player.externalId),
      footballDataProvider.fetchPlayerSeasonStatistics(player.externalId, seasonYear),
    ]);
  } catch (error) {
    // Profile/season-stats are supplementary display data, not part of the scoring pipeline —
    // a provider outage or missing FOOTBALL_DATA_API_KEY shouldn't take down the player page.
    console.error("getPlayer: failed to fetch live profile/season-statistics", error);
  }

  return jsonResponse(200, { ...playerWithStats, profile, seasonStatistics });
};
