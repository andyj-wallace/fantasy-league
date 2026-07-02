import { beforeEach, describe, expect, it } from "vitest";
import { registerLoginAttempt, resetLoginRateLimiter } from "./loginRateLimiter";

beforeEach(() => {
  resetLoginRateLimiter();
});

describe("registerLoginAttempt", () => {
  it("allows attempts up to the limit and blocks the ones beyond it", () => {
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(registerLoginAttempt("key", now).allowed).toBe(true);
    }
    const blocked = registerLoginAttempt("key", now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks keys independently", () => {
    const now = 2_000_000;
    for (let i = 0; i < 11; i++) registerLoginAttempt("a", now);
    expect(registerLoginAttempt("a", now).allowed).toBe(false);
    expect(registerLoginAttempt("b", now).allowed).toBe(true);
  });

  it("lets attempts through again once the window has passed", () => {
    const start = 3_000_000;
    for (let i = 0; i < 11; i++) registerLoginAttempt("key", start);
    expect(registerLoginAttempt("key", start).allowed).toBe(false);

    // More than a minute later, the earlier attempts have aged out of the window.
    expect(registerLoginAttempt("key", start + 61_000).allowed).toBe(true);
  });
});
