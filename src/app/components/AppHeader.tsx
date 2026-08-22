"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getStoredToken } from "@/app/lib/auth";
import { logOut } from "@/app/lib/cognitoAuth";
import { useCurrentGameweekContext } from "@/app/lib/gameweekContext";
import { formatDayAndTime } from "@/app/lib/formatDate";

/** The one global chrome bar: brand link home, a compact current-gameweek chip, and the single
 * Log out button (pages no longer carry their own). Login state is re-read on every route change
 * because it lives in localStorage, not React state shared across pages. */
export function AppHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const currentGameweek = useCurrentGameweekContext();

  useEffect(() => {
    setIsLoggedIn(getStoredToken() !== null);
  }, [pathname]);

  function handleLogout() {
    logOut();
    setIsLoggedIn(false);
    router.push("/");
  }

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/" className="app-header-brand">
          Fantasy League
        </Link>
        {isLoggedIn && currentGameweek?.gameweek && (
          <span
            className="badge badge-blue"
            title={`Deadline ${formatDayAndTime(currentGameweek.gameweek.deadlineAt)}`}
          >
            GW {currentGameweek.gameweek.number}
          </span>
        )}
        <span className="app-header-actions">
          <Link href="/help">Help</Link>
          {isLoggedIn && <button onClick={handleLogout}>Log out</button>}
        </span>
      </div>
    </header>
  );
}
