import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Unit-test runner for the scoring engine and auth providers. Tests are pure and mock the
 * database repositories (see `vi.mock("../db/repositories", ...)` in each scoring test), so no
 * Postgres is required. `globals` stays off — tests import { describe, it, expect, vi } explicitly.
 * The `@/*` alias mirrors tsconfig.json's `paths` mapping — Next.js resolves that natively, but
 * Vitest needs it spelled out here for frontend files (src/app/**) to import via `@/...`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
  },
});
