import { getStoredToken } from "@/app/lib/auth";
import { getFreshCognitoIdToken, isCognitoAuthEnabled } from "@/app/lib/cognitoAuth";

/** Same as fetch, but attaches the session token as a Bearer header — every request to the API
 * goes through this now that handlers require it. In Cognito mode the token is pulled from the
 * Cognito session, which transparently refreshes an expired ID token; in local dev it's the
 * stored signed token. */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = isCognitoAuthEnabled() ? await getFreshCognitoIdToken() : getStoredToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}
