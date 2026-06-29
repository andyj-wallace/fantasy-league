import { getStoredToken } from "@/app/lib/auth";

/** Same as fetch, but attaches the stored session token as a Bearer header — every mutating
 * request to the API goes through this now that handlers require it. */
export function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getStoredToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}
