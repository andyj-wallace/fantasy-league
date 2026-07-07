"use client";

import { storeHubViewPreference } from "@/app/lib/standalonePageGate";

/** The visible half of the standalone-page gate: a one-line strip letting the visitor jump into
 * the consolidated league hub (remembering that choice for next time) while they're looking at a
 * standalone page. `onOpenInHub` navigates to the page's hub equivalent; it's async because the hub
 * URL can require discovering the team's league first. */
export function StandaloneViewToggle({ onOpenInHub }: { onOpenInHub: () => void | Promise<void> }) {
  return (
    <div className="view-mode-toggle">
      <span className="view-mode-toggle-label">Standalone view</span>
      <button
        type="button"
        className="btn-link"
        onClick={() => {
          storeHubViewPreference(true);
          void onOpenInHub();
        }}
      >
        Open in league hub →
      </button>
    </div>
  );
}
