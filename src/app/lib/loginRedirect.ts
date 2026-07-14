const REDIRECT_PARAM = "redirect";

/** Builds a /login URL that carries a same-app return path, so a signed-out visitor (e.g. one
 * following a league invite link) can be sent back to what they were doing after they log in
 * or sign up. */
export function buildLoginUrlWithRedirect(returnPath: string): string {
  return `/login?${REDIRECT_PARAM}=${encodeURIComponent(returnPath)}`;
}

/** Reads and validates the `redirect` query param on the login page. Only same-app paths are
 * honored — anything else (a full URL, a protocol-relative "//evil.com" or "/\evil.com") is
 * rejected so /login can't be turned into an open redirect. */
export function getValidatedLoginRedirectTarget(): string | null {
  if (typeof window === "undefined") return null;
  const redirectParam = new URLSearchParams(window.location.search).get(REDIRECT_PARAM);
  if (!redirectParam) return null;
  if (!redirectParam.startsWith("/") || redirectParam.startsWith("//") || redirectParam.startsWith("/\\")) {
    return null;
  }
  return redirectParam;
}
