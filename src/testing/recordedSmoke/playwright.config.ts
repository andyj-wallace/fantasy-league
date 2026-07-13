import { defineConfig } from "playwright/test";
import {
  playwrightHtmlReportDirectory,
  playwrightTestOutputDirectory,
  repositoryRoot,
} from "./recordedSmokeArtifactPaths";

/**
 * Playwright config for the recorded gameweek-lifecycle smoke suite. Always launched through
 * `npm run smoke:recorded` (src/testing/recordedSmoke/runRecordedSmokeTest.ts), which provisions
 * the throwaway smoke database and repoints DATABASE_URL before this file loads.
 *
 * The web server pair is deliberately on its own ports (API :3101, web :3100) and refuses to
 * reuse an existing server, so a run can never attach to — or disturb — the live dev servers.
 */

const smokeDatabaseUrl = process.env.DATABASE_URL ?? "";
if (!new URL(smokeDatabaseUrl).pathname.endsWith("_smoke")) {
  throw new Error(
    "Recorded smoke suite must run against a *_smoke database — launch it via `npm run smoke:recorded`, not `playwright test` directly",
  );
}

export default defineConfig({
  testDir: __dirname,
  testMatch: "**/*.recorded.spec.ts",
  workers: 1,
  timeout: 10 * 60 * 1000,
  expect: { timeout: 15_000 },
  outputDir: playwrightTestOutputDirectory,
  reporter: [["list"], ["html", { outputFolder: playwrightHtmlReportDirectory, open: "never" }]],
  use: {
    baseURL: "http://localhost:3100",
    video: "on",
    trace: "on",
    timezoneId: "America/New_York",
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
  },
  webServer: [
    {
      command: "npx tsx src/api/index.ts",
      cwd: repositoryRoot,
      port: 3101,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { DATABASE_URL: smokeDatabaseUrl, AUTH_PROVIDER: "stub", PORT: "3101" },
    },
    {
      command: "npx next dev -p 3100",
      cwd: repositoryRoot,
      port: 3100,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_API_BASE_URL: "http://localhost:3101",
        NEXT_DIST_DIR: ".next-recorded-smoke",
        // Force the passwordless/stub-token frontend even when the developer's .env configures
        // Cognito (Next.js only reads .env values for vars not already set, and empty is falsy
        // to isCognitoAuthEnabled) — in Cognito mode authedFetch ignores the injected stub token.
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: "",
        NEXT_PUBLIC_COGNITO_APP_CLIENT_ID: "",
      },
    },
  ],
});
