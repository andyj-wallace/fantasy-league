"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

/** Body-scroll is locked while any overlay is open. A counter (rather than a plain flag) keeps the
 * lock correct when a player popup is stacked on top of a transfers panel — the body only scrolls
 * again once the last overlay closes. */
let openOverlayCount = 0;

function lockBodyScroll(): void {
  openOverlayCount += 1;
  document.body.style.overflow = "hidden";
}

function unlockBodyScroll(): void {
  openOverlayCount = Math.max(0, openOverlayCount - 1);
  if (openOverlayCount === 0) document.body.style.overflow = "";
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

export type OverlayVariant = "popup" | "panel";

/** The one modal surface the league hub uses to host a folded-in screen in-place instead of
 * navigating away. `popup` is a centered dialog for small/read-only content (a player's details);
 * `panel` is a slide-up sheet for a larger interactive surface (transfers, later the squad
 * builder). Handles Escape-to-close, backdrop-click-to-close, body scroll lock, focus restoration,
 * and a minimal Tab focus trap. Stacking is supported: a popup sits above a panel. */
export function Overlay({
  title,
  onClose,
  variant = "popup",
  children,
}: {
  title: string;
  onClose: () => void;
  variant?: OverlayVariant;
  children: ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const elementFocusedBeforeOpen = useRef<HTMLElement | null>(null);

  useEffect(() => {
    elementFocusedBeforeOpen.current = document.activeElement as HTMLElement | null;
    lockBodyScroll();
    surfaceRef.current?.focus();
    return () => {
      unlockBodyScroll();
      elementFocusedBeforeOpen.current?.focus?.();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = getFocusableElements(surfaceRef.current);
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className={`overlay-backdrop overlay-backdrop--${variant}`} onMouseDown={onClose}>
      <div
        ref={surfaceRef}
        className={`overlay-surface overlay-surface--${variant}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="overlay-header">
          <h2 className="overlay-title">{title}</h2>
          <button type="button" className="overlay-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="overlay-body">{children}</div>
      </div>
    </div>
  );
}
