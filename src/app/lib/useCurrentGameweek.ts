import { useEffect, useState } from "react";
import { API_CACHE_TTL_MS, getCachedJson } from "@/app/lib/apiCache";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import type { GameweekStatus, MatchStatus } from "../../domain";

export interface CurrentGameweekSummary {
  id: string;
  number: number;
  status: GameweekStatus;
  deadlineAt: string;
}

export interface GameweekMatchSummary {
  id: string;
  homeClub: string;
  awayClub: string;
  kickoffAt: string;
  status: MatchStatus;
  finalHomeScore: number | null;
  finalAwayScore: number | null;
}

export interface CurrentGameweekResponse {
  gameweek: CurrentGameweekSummary | null;
  matches: GameweekMatchSummary[];
}

/** Fetches the current gameweek + its fixtures once on mount, routed through the shared GET cache
 * so the several places this hook is called on one page (header, page body, panels) collapse into
 * a single network request. Once a gameweek is fully scored it can't change again until the next
 * one starts — days away, not minutes — so a completed gameweek is cached far longer than one
 * still in progress. Returns null while loading or on failure — season-awareness UI (banner,
 * fixtures list) is an additive layer, so pages render fine without it rather than blocking on
 * this request. Pass `skipFetch` when the caller already has the response (e.g. a page passing
 * its own copy into GameweekBanner). */
export function useCurrentGameweek(skipFetch = false): CurrentGameweekResponse | null {
  const [currentGameweek, setCurrentGameweek] = useState<CurrentGameweekResponse | null>(null);

  useEffect(() => {
    if (skipFetch) return;
    let isCancelled = false;
    getCachedJson<CurrentGameweekResponse>(
      `${getApiBaseUrl()}/gameweeks/current`,
      (result) => (result.gameweek?.status === "COMPLETED" ? API_CACHE_TTL_MS.GAMEWEEK_COMPLETED : API_CACHE_TTL_MS.SHORT),
    )
      .then((result) => {
        if (!isCancelled) setCurrentGameweek(result);
      })
      .catch(() => {});
    return () => {
      isCancelled = true;
    };
  }, [skipFetch]);

  return currentGameweek;
}
