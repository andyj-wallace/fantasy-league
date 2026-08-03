import { timingSafeEqual } from "node:crypto";

/** The header CloudFront injects on the /api/* origin request (infra/lib/fantasyLeagueStack.ts).
 * CloudFront overwrites any same-named header the viewer sent, so a client cannot forge it. */
export const CLOUDFRONT_ORIGIN_VERIFY_HEADER_NAME = "x-origin-verify";

/**
 * The HTTP API's execute-api URL is public and cannot be disabled without a custom domain, so
 * CloudFront proves it is the caller with a shared secret and the API rejects everything else.
 * That makes the CDN the only usable path — and therefore the only path that has to be
 * rate-limited, cached, or (later) put behind a WAF.
 *
 * Returns true when `expectedSecret` is unset: the check is only enforced where it is
 * configured, which is the deployed API Lambda. Local dev and tests run without it.
 */
export function requestCarriesValidCloudFrontOriginSecret(
  headers: Record<string, string | undefined> | null | undefined,
  expectedSecret: string | undefined,
): boolean {
  if (!expectedSecret) return true;

  // API Gateway payload format 1.0 lowercases header names, but the local server and tests
  // may not — same two-spelling lookup the auth layer uses (src/api/auth/requireAuth.ts).
  const presentedSecret =
    headers?.[CLOUDFRONT_ORIGIN_VERIFY_HEADER_NAME] ?? headers?.["X-Origin-Verify"];
  if (presentedSecret === undefined) return false;

  return constantTimeEquals(presentedSecret, expectedSecret);
}

/** timingSafeEqual throws on length mismatch, so length is compared first. Leaking the length
 * of a fixed-size token is not meaningful; leaking how many bytes matched would be. */
function constantTimeEquals(presented: string, expected: string): boolean {
  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (presentedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(presentedBytes, expectedBytes);
}
