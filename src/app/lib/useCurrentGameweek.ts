import { useEffect, useState } from "react";
import { authedFetch } from "@/app/lib/apiFetch";
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

/** Fetches the current gameweek + its fixtures once on mount. Returns null while loading or on
 * failure — season-awareness UI (banner, fixtures list) is an additive layer, so pages render
 * fine without it rather than blocking on this request. Pass `skipFetch` when the caller already
 * has the response (e.g. a page passing its own copy into GameweekBanner). */
export function useCurrentGameweek(skipFetch = false): CurrentGameweekResponse | null {
  const [currentGameweek, setCurrentGameweek] = useState<CurrentGameweekResponse | null>(null);

  useEffect(() => {
    if (skipFetch) return;
    let isCancelled = false;
    authedFetch(`${getApiBaseUrl()}/gameweeks/current`)
      .then((response) => (response.ok ? response.json() : null))
      .then((result: CurrentGameweekResponse | null) => {
        if (!isCancelled && result) setCurrentGameweek(result);
      })
      .catch(() => {});
    return () => {
      isCancelled = true;
    };
  }, [skipFetch]);

  return currentGameweek;
}
