import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
}));

vi.mock("@/app/lib/apiFetch", () => ({
  fetchJson: mocks.fetchJson,
}));

import { clearApiCache, getCachedJson, invalidateCached } from "./apiCache";

beforeEach(() => {
  mocks.fetchJson.mockReset();
  clearApiCache();
});

describe("getCachedJson", () => {
  it("issues a real fetch on first call", async () => {
    mocks.fetchJson.mockResolvedValue({ value: 1 });

    const result = await getCachedJson("/thing", 1000);

    expect(result).toEqual({ value: 1 });
    expect(mocks.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("returns the cached value without refetching while still fresh", async () => {
    mocks.fetchJson.mockResolvedValue({ value: 1 });

    await getCachedJson("/thing", 1000);
    await getCachedJson("/thing", 1000);

    expect(mocks.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetchJson.mockResolvedValue({ value: 1 });

      await getCachedJson("/thing", 1000);
      vi.advanceTimersByTime(1001);
      await getCachedJson("/thing", 1000);

      expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one in-flight request across concurrent callers", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    mocks.fetchJson.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = getCachedJson("/thing", 1000);
    const second = getCachedJson("/thing", 1000);
    resolveFetch({ value: 1 });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({ value: 1 });
    expect(secondResult).toEqual({ value: 1 });
    expect(mocks.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("computes the TTL from the response body when given a function", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetchJson.mockResolvedValue({ status: "COMPLETED" });
      const ttlFromStatus = (data: { status: string }) => (data.status === "COMPLETED" ? 10_000 : 100);

      await getCachedJson("/gw", ttlFromStatus);
      vi.advanceTimersByTime(5_000);
      await getCachedJson("/gw", ttlFromStatus);
      expect(mocks.fetchJson).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(6_000);
      await getCachedJson("/gw", ttlFromStatus);
      expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a rejected fetch, so the next call retries", async () => {
    mocks.fetchJson.mockRejectedValueOnce(new Error("network error"));

    await expect(getCachedJson("/thing", 1000)).rejects.toThrow("network error");

    mocks.fetchJson.mockResolvedValueOnce({ value: 1 });
    const result = await getCachedJson("/thing", 1000);

    expect(result).toEqual({ value: 1 });
    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
  });
});

describe("invalidateCached", () => {
  it("forces a refetch for an exact path match", async () => {
    mocks.fetchJson.mockResolvedValue({ value: 1 });
    await getCachedJson("/thing", 1000);

    invalidateCached("/thing");
    await getCachedJson("/thing", 1000);

    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
  });

  it("leaves non-matching paths cached", async () => {
    mocks.fetchJson.mockResolvedValue({ value: 1 });
    await getCachedJson("/thing", 1000);
    await getCachedJson("/other", 1000);

    invalidateCached("/thing");
    await getCachedJson("/other", 1000);

    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
  });

  it("matches multiple paths via a predicate", async () => {
    mocks.fetchJson.mockResolvedValue({ value: 1 });
    await getCachedJson("/teams/1", 1000);
    await getCachedJson("/teams/1/transfers/available", 1000);

    invalidateCached((path) => path.startsWith("/teams/1"));
    await getCachedJson("/teams/1", 1000);
    await getCachedJson("/teams/1/transfers/available", 1000);

    expect(mocks.fetchJson).toHaveBeenCalledTimes(4);
  });
});

describe("clearApiCache", () => {
  it("drops every cached entry", async () => {
    mocks.fetchJson.mockResolvedValue({ value: 1 });
    await getCachedJson("/thing", 1000);

    clearApiCache();
    await getCachedJson("/thing", 1000);

    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
  });
});
