import { defineConfig } from "vitest/config";

/**
 * Unit-test runner for the scoring engine and auth providers. Tests are pure and mock the
 * database repositories (see `vi.mock("../db/repositories", ...)` in each scoring test), so no
 * Postgres is required. `globals` stays off — tests import { describe, it, expect, vi } explicitly.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
  },
});
