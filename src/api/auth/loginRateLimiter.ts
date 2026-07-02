/**
 * A tiny in-process sliding-window rate limiter for the login endpoint, to blunt credential
 * brute-forcing. V1 runs as a single process at small scale, so an in-memory map is sufficient;
 * note that limits are therefore *per instance* — if the API is ever scaled horizontally this
 * needs to move to a shared store (e.g. Redis).
 */

const WINDOW_MS = 60_000; // 1 minute
const MAX_ATTEMPTS_PER_WINDOW = 10;

/** Timestamps (ms) of recent attempts, most-recent-last, keyed by caller identity (email/IP). */
const attemptTimestampsByKey = new Map<string, number[]>();

/**
 * Records one attempt for `key` and reports whether it is allowed. Returns `allowed: false` once
 * more than MAX_ATTEMPTS_PER_WINDOW attempts land within the trailing WINDOW_MS.
 */
export function registerLoginAttempt(key: string, now: number = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
  const windowStart = now - WINDOW_MS;
  const recentTimestamps = (attemptTimestampsByKey.get(key) ?? []).filter((timestamp) => timestamp > windowStart);
  recentTimestamps.push(now);
  attemptTimestampsByKey.set(key, recentTimestamps);

  if (recentTimestamps.length > MAX_ATTEMPTS_PER_WINDOW) {
    const oldestInWindow = recentTimestamps[0]!;
    const retryAfterSeconds = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Test hook: clears all recorded attempts. */
export function resetLoginRateLimiter(): void {
  attemptTimestampsByKey.clear();
}
