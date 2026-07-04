import { getStoredToken } from "@/app/lib/auth";
import { getFreshCognitoIdToken, isCognitoAuthEnabled, logOut } from "@/app/lib/cognitoAuth";

/** Same as fetch, but attaches the session token as a Bearer header — every request to the API
 * goes through this now that handlers require it. In Cognito mode the token is pulled from the
 * Cognito session, which transparently refreshes an expired ID token; in local dev it's the
 * stored signed token.
 * A 401 means the session is no longer valid (expired signed token, revoked Cognito session):
 * the stale session is cleared and the user is sent to log back in, instead of every page
 * surfacing it as a generic "could not load" error. */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = isCognitoAuthEnabled() ? await getFreshCognitoIdToken() : getStoredToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    logOut();
    window.location.assign("/login?expired=1");
  }
  return response;
}
