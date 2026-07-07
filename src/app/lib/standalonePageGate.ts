"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Viewport width (px) at or above which the hub is the default view. Matches the CSS breakpoint
 * where the league page gains its two-column sidebar layout — below it (phones and narrow tablets)
 * the standalone full pages read better than large slide-up overlays, so those default to
 * standalone. Kept in sync with the `@media (min-width: 1024px)` rules in globals.css.
 */
export const HUB_DEFAULT_MIN_WIDTH = 1024;

/**
 * The default view when the visitor hasn't chosen and there's no `?view=` override: the hub on
 * desktop-width screens, the standalone page below that. Option A still holds — both experiences
 * coexist and nothing is deleted; this only changes which one a first-time visitor lands on, by
 * device. Evaluated client-side at gate time (the gate only runs in an effect, so `window` exists).
 */
function hubIsDefaultForViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(`(min-width: ${HUB_DEFAULT_MIN_WIDTH}px)`).matches;
}

const PREFER_HUB_STORAGE_KEY = "fl:preferHubView";

/** The visitor's remembered choice, set by the on-page toggle. `null` = never chosen. */
function readStoredHubPreference(): boolean | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(PREFER_HUB_STORAGE_KEY);
  if (raw === "hub") return true;
  if (raw === "standalone") return false;
  return null;
}

export function storeHubViewPreference(preferHub: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PREFER_HUB_STORAGE_KEY, preferHub ? "hub" : "standalone");
}

export type StandaloneGateStatus = "checking" | "render" | "redirecting";

/**
 * Decides whether a standalone page should render its own content or hand off to the league hub,
 * and performs the redirect when it should. Resolution order (first match wins):
 *
 *   1. `?view=hub` / `?view=standalone` in the URL — an explicit per-visit override (a link can
 *      force either experience regardless of device or saved preference).
 *   2. The visitor's saved preference in localStorage (set by the on-page toggle) — honoured on
 *      any device once chosen.
 *   3. The device default: the hub at desktop width, the standalone page on phones/narrow tablets.
 *
 * When the decision is "hub", it asks the page for the equivalent hub URL via `resolveHubUrl`
 * (which may need a fetch — e.g. to discover a team's league) and `router.replace`s there. If the
 * page can't produce one (no league yet, network error), it falls back to rendering standalone so
 * the user is never stranded on a blank page.
 *
 * `resolveHubUrl` is only invoked when a hub hand-off is actually chosen, so the normal standalone
 * render path pays no extra fetch.
 */
export function useStandalonePageGate(resolveHubUrl: () => Promise<string | null>): StandaloneGateStatus {
  const searchParams = useSearchParams();
  const router = useRouter();
  const viewOverride = searchParams.get("view");
  const [status, setStatus] = useState<StandaloneGateStatus>("checking");

  useEffect(() => {
    const preferHub =
      viewOverride === "hub"
        ? true
        : viewOverride === "standalone"
          ? false
          : readStoredHubPreference() ?? hubIsDefaultForViewport();

    if (!preferHub) {
      setStatus("render");
      return;
    }

    let cancelled = false;
    setStatus("checking");
    resolveHubUrl()
      .then((hubUrl) => {
        if (cancelled) return;
        if (hubUrl) {
          setStatus("redirecting");
          router.replace(hubUrl);
        } else {
          setStatus("render");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("render");
      });
    return () => {
      cancelled = true;
    };
    // resolveHubUrl is recreated each render; the decision only depends on the view override.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewOverride]);

  return status;
}
