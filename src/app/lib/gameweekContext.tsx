"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { API_CACHE_TTL_MS, getCachedJson } from "@/app/lib/apiCache";
import { getApiBaseUrl } from "@/app/lib/apiBaseUrl";
import { getStoredToken } from "@/app/lib/auth";
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

const CurrentGameweekContext = createContext<CurrentGameweekResponse | null>(null);

/** Fetches the current gameweek + its fixtures once per route change and shares the result via
 * context, so the several places that need it (header, page body, panels) collapse into a
 * single hook instance and — via the shared GET cache — a single network request. Skips the
 * fetch entirely while logged out, since an authed request would 401 and trigger a spurious
 * logout on public pages. Once a gameweek is fully scored it can't change again until the next
 * one starts — days away, not minutes — so a completed gameweek is cached far longer than one
 * still in progress. Consumers see null while loading, on failure, or while logged out —
 * season-awareness UI (banner, fixtures list) is an additive layer, so pages render fine without
 * it rather than blocking on this request. */
export function CurrentGameweekProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [currentGameweek, setCurrentGameweek] = useState<CurrentGameweekResponse | null>(null);

  useEffect(() => {
    if (!getStoredToken()) return;
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
  }, [pathname]);

  return <CurrentGameweekContext.Provider value={currentGameweek}>{children}</CurrentGameweekContext.Provider>;
}

export function useCurrentGameweekContext(): CurrentGameweekResponse | null {
  return useContext(CurrentGameweekContext);
}
