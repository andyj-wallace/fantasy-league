import { fetchJson } from "@/app/lib/apiFetch";

type TtlPolicy<T> = number | ((data: T) => number);

interface CacheEntry<T> {
  data?: T;
  expiresAt: number;
  inFlightPromise?: Promise<T>;
}

/** Named TTLs for the read call sites that route through this cache — see the "TTL & invalidation
 * policy" table in the client-side caching plan for the rationale behind each duration. */
export const API_CACHE_TTL_MS = {
  SHORT: 30_000,
  STANDINGS: 2 * 60_000,
  PLAYER_DATA: 5 * 60_000,
  GAMEWEEK_COMPLETED: 10 * 60_000,
} as const;

const cache = new Map<string, CacheEntry<unknown>>();

/** Fetches `path` as JSON, but reuses a still-fresh cached response or an in-flight request for
 * the same path instead of issuing a new network call — this is what collapses concurrent mounts
 * (e.g. AppHeader and a page both wanting the current gameweek) into a single request.
 * `ttl` is either a fixed number of milliseconds, or a function of the resolved response body,
 * for endpoints whose freshness depends on what came back (a completed gameweek can be cached far
 * longer than one still in progress). There's no background revalidation — a stale entry just
 * means the next call does a real fetch, same as an uncached fetch would. */
export function getCachedJson<T>(path: string, ttl: TtlPolicy<T>): Promise<T> {
  const now = Date.now();
  const entry = cache.get(path) as CacheEntry<T> | undefined;

  if (entry && entry.data !== undefined && now < entry.expiresAt) {
    return Promise.resolve(entry.data);
  }
  if (entry?.inFlightPromise) {
    return entry.inFlightPromise;
  }

  const inFlightPromise = fetchJson<T>(path)
    .then((data) => {
      const expiresAt = now + (typeof ttl === "function" ? ttl(data) : ttl);
      cache.set(path, { data, expiresAt });
      return data;
    })
    .catch((error) => {
      cache.delete(path);
      throw error;
    });

  cache.set(path, { data: entry?.data, expiresAt: entry?.expiresAt ?? 0, inFlightPromise });
  return inFlightPromise;
}

/** Drops cached entries so the next getCachedJson call for them issues a real fetch — for data a
 * mutation just changed, where waiting out the TTL could show stale results. Accepts an exact
 * path, or a predicate to match several paths at once (e.g. every read for one team). */
export function invalidateCached(matcher: string | ((path: string) => boolean)): void {
  const matches = typeof matcher === "string" ? (path: string) => path === matcher : matcher;
  for (const path of cache.keys()) {
    if (matches(path)) cache.delete(path);
  }
}

/** Drops every cached entry — called on logout so a session boundary never leaks one user's
 * cached reads into the next login on the same browser. */
export function clearApiCache(): void {
  cache.clear();
}
