const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

function getConfiguredApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
}

/**
 * On the server (Server Components, SSR), always the configured value — the Next.js process and
 * the API process share a host, so `localhost` is correct there regardless of requesting device.
 *
 * In the browser, if the configured value points at localhost but the page was loaded from a
 * different host (e.g. a LAN IP, when accessing the dev server from a phone), `localhost` would
 * resolve to the requesting device rather than the machine running the API — so swap in the
 * page's own hostname, keeping the configured protocol and port. Any non-localhost configured
 * value (a real deployed API domain) is always left untouched.
 */
export function getApiBaseUrl(): string {
  const configured = getConfiguredApiBaseUrl();

  if (typeof window === "undefined") return configured;

  const configuredUrl = new URL(configured);
  if (!LOCALHOST_HOSTNAMES.has(configuredUrl.hostname)) return configured;
  if (LOCALHOST_HOSTNAMES.has(window.location.hostname)) return configured;

  configuredUrl.hostname = window.location.hostname;
  return configuredUrl.origin;
}
