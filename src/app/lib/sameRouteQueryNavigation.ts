"use client";

/**
 * Navigation that stays on the current route and only changes the query string — what the league
 * hub's overlay routing is built on (`?panel=squad`, `?playerId=…`).
 *
 * `useRouter().push()` cannot express this in our deployment. The frontend ships as a static export
 * (`output: "export"`), so there is exactly one prerendered payload per route; the App Router treats
 * a push whose pathname already matches the current page as nothing to do and silently drops it. The
 * click handler runs, the URL never changes, and `useSearchParams` never re-renders — which is why
 * the hub's Squad and Transfers buttons did nothing while every cross-route link worked.
 *
 * Next.js supports the native History API for exactly this case: `pushState`/`replaceState` are
 * integrated with the App Router, so `usePathname`/`useSearchParams` stay in sync, and the browser
 * Back button still pops the entry — which is how an overlay closes.
 *
 * Prefer `next/link` for anything that changes route; it handles those correctly. These helpers are
 * only for query-string-only moves within one route.
 */

function buildCurrentRouteUrlWithQueryString(queryParameters: URLSearchParams): string {
  const queryString = queryParameters.toString();
  return queryString ? `${window.location.pathname}?${queryString}` : window.location.pathname;
}

/** Adds a history entry, so Escape/backdrop/Back can pop straight back to the previous state. */
export function pushSameRouteQueryString(queryParameters: URLSearchParams): void {
  window.history.pushState(null, "", buildCurrentRouteUrlWithQueryString(queryParameters));
}

/** Rewrites the current history entry, for when going "back" to this state would make no sense. */
export function replaceSameRouteQueryString(queryParameters: URLSearchParams): void {
  window.history.replaceState(null, "", buildCurrentRouteUrlWithQueryString(queryParameters));
}
