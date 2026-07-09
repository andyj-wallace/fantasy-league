import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFootballProvider } from "./apiFootballProvider";

/**
 * Rate-limit behavior tests for ApiFootballProvider.request(): capturing the provider's
 * rate-limit response headers, serving fetchQuotaStatus from them instead of the /status call,
 * pacing against the per-minute cap, and the 429 retry-once policy. Real fetch is stubbed;
 * fake timers unblock the deliberate waits (always the async advance variant — the waits are
 * awaited promises).
 */

const EMPTY_FIXTURES_ENVELOPE = { response: [], errors: [] };
const STATUS_ENVELOPE = { response: { requests: { current: 40, limit_day: 100 } }, errors: [] };

function jsonResponse(envelope: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(envelope), {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

function newProvider(): ApiFootballProvider {
  return new ApiFootballProvider("https://stubbed.invalid", "test-no-key", 2024);
}

describe("ApiFootballProvider rate-limit header handling", () => {
  const fetchMock = vi.fn<(url: URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("serves fetchQuotaStatus from headers observed on an earlier call, with no /status round trip", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(EMPTY_FIXTURES_ENVELOPE, {
        // Mixed casing on purpose — Headers.get() must match case-insensitively.
        headers: { "X-RateLimit-Requests-Limit": "100", "X-RateLimit-Requests-Remaining": "77" },
      }),
    );

    const provider = newProvider();
    await provider.fetchLiveFixtures();
    const quota = await provider.fetchQuotaStatus();

    expect(quota).toEqual({ requestsUsedToday: 23, requestsLimitPerDay: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the /status call when no rate-limit headers have been observed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY_FIXTURES_ENVELOPE));
    fetchMock.mockResolvedValueOnce(jsonResponse(STATUS_ENVELOPE));

    const provider = newProvider();
    await provider.fetchLiveFixtures();
    const quota = await provider.fetchQuotaStatus();

    expect(quota).toEqual({ requestsUsedToday: 40, requestsLimitPerDay: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const statusUrl = fetchMock.mock.calls[1]![0];
    expect(String(statusUrl)).toContain("/status");
  });

  it("falls back to the /status call when the snapshot predates the UTC-midnight quota reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T23:59:00Z"));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(EMPTY_FIXTURES_ENVELOPE, {
        headers: { "x-ratelimit-requests-limit": "100", "x-ratelimit-requests-remaining": "5" },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(STATUS_ENVELOPE));

    const provider = newProvider();
    await provider.fetchLiveFixtures();

    vi.setSystemTime(new Date("2026-07-08T00:01:00Z"));
    const quota = await provider.fetchQuotaStatus();

    expect(quota).toEqual({ requestsUsedToday: 40, requestsLimitPerDay: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a header-less response wipe out a previously captured snapshot", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(EMPTY_FIXTURES_ENVELOPE, {
        headers: { "x-ratelimit-requests-limit": "100", "x-ratelimit-requests-remaining": "90" },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY_FIXTURES_ENVELOPE));

    const provider = newProvider();
    await provider.fetchLiveFixtures();
    await provider.fetchLiveFixtures();
    const quota = await provider.fetchQuotaStatus();

    expect(quota).toEqual({ requestsUsedToday: 10, requestsLimitPerDay: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("ApiFootballProvider per-minute pacing", () => {
  const fetchMock = vi.fn<(url: URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits out the per-minute window before dispatching when the observed remaining is at the reserve", async () => {
    // mockImplementation (not mockResolvedValue): a Response body is single-use, so every fetch
    // needs a freshly constructed Response. Same for the other repeated-return mocks below.
    fetchMock.mockImplementation(async () =>
      jsonResponse(EMPTY_FIXTURES_ENVELOPE, {
        headers: { "x-ratelimit-limit": "10", "x-ratelimit-remaining": "1" },
      }),
    );

    const provider = newProvider();
    await provider.fetchLiveFixtures();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const secondCall = provider.fetchLiveFixtures();
    // The pre-flight wait must hold the dispatch back until the minute window has passed.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(62_000);
    await secondCall;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dispatches immediately when the observed exhausted window has already rolled over", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(EMPTY_FIXTURES_ENVELOPE, {
        headers: { "x-ratelimit-limit": "10", "x-ratelimit-remaining": "0" },
      }),
    );

    const provider = newProvider();
    await provider.fetchLiveFixtures();

    vi.setSystemTime(new Date(Date.now() + 61_000));
    await provider.fetchLiveFixtures();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never paces when no rate-limit headers have been observed (offline/in-memory parity)", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(EMPTY_FIXTURES_ENVELOPE));

    const provider = newProvider();
    await provider.fetchLiveFixtures();
    await provider.fetchLiveFixtures();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("ApiFootballProvider 429 retry-once", () => {
  const fetchMock = vi.fn<(url: URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits out the minute window and retries once after a per-minute 429, then succeeds", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { response: [], errors: [] },
        { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-requests-remaining": "50" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY_FIXTURES_ENVELOPE));

    const provider = newProvider();
    const call = provider.fetchLiveFixtures();
    await vi.advanceTimersByTimeAsync(65_000);
    await expect(call).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws with the standard error message when the retry is also rate-limited", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        { response: [], errors: [] },
        { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-requests-remaining": "50" } },
      ),
    );

    const provider = newProvider();
    const call = provider.fetchLiveFixtures();
    const assertion = expect(call).rejects.toThrow(/API-Football request failed: 429/);
    await vi.advanceTimersByTimeAsync(65_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws immediately without retrying when the 429's headers show the daily quota is spent", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        { response: [], errors: [] },
        { status: 429, headers: { "x-ratelimit-requests-limit": "100", "x-ratelimit-requests-remaining": "0" } },
      ),
    );

    const provider = newProvider();
    await expect(provider.fetchLiveFixtures()).rejects.toThrow(/API-Football request failed: 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours the 429's Retry-After header instead of the window estimate", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { response: [], errors: [] },
        { status: 429, headers: { "retry-after": "3", "x-ratelimit-requests-remaining": "50" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY_FIXTURES_ENVELOPE));

    const provider = newProvider();
    const call = provider.fetchLiveFixtures();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_100);
    await expect(call).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clamps an excessive Retry-After to the 120s ceiling", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { response: [], errors: [] },
        { status: 429, headers: { "retry-after": "999", "x-ratelimit-requests-remaining": "50" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY_FIXTURES_ENVELOPE));

    const provider = newProvider();
    const call = provider.fetchLiveFixtures();

    await vi.advanceTimersByTimeAsync(119_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(call).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the window estimate when Retry-After is unparseable", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { response: [], errors: [] },
        { status: 429, headers: { "retry-after": "soon", "x-ratelimit-remaining": "0", "x-ratelimit-requests-remaining": "50" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY_FIXTURES_ENVELOPE));

    const provider = newProvider();
    const call = provider.fetchLiveFixtures();
    await vi.advanceTimersByTimeAsync(65_000);
    await expect(call).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
