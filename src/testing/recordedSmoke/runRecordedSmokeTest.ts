import "dotenv/config";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { provisionRecordedSmokeDatabase } from "./provisionRecordedSmokeDatabase";
import { recordedSmokeArtifactsRoot, repositoryRoot } from "./recordedSmokeArtifactPaths";

/**
 * Orchestrates one recorded smoke run (`npm run smoke:recorded`):
 *   1. derives a throwaway "<dev database>_smoke" database URL and recreates that database,
 *   2. runs the Drizzle migrations against it and seeds the scenario's starting entities,
 *   3. runs the Playwright suite, whose config boots an isolated API (:3101) and web (:3100)
 *      server pair — never the live dev servers on :3000/:3001.
 *
 * DATABASE_URL is repointed at the smoke database BEFORE any src/db module is imported (the pg
 * pool binds to it at import time), which is why the seed is loaded with a dynamic import.
 */
async function main(): Promise<void> {
  const developmentDatabaseUrl =
    process.env.DATABASE_URL ?? "postgres://user:password@localhost:5432/fantasy_league";
  const smokeUrl = new URL(developmentDatabaseUrl);
  smokeUrl.pathname = `${smokeUrl.pathname.replace(/\/$/, "")}_smoke`;
  const smokeDatabaseUrl = smokeUrl.toString();

  process.env.DATABASE_URL = smokeDatabaseUrl;
  process.env.AUTH_PROVIDER = "stub";

  console.log(`[smoke:recorded] using throwaway database ${smokeUrl.pathname.slice(1)}`);
  rmSync(recordedSmokeArtifactsRoot, { recursive: true, force: true });

  await provisionRecordedSmokeDatabase(smokeDatabaseUrl);
  runStep("migrate", "npx", ["drizzle-kit", "migrate"]);

  const { seedGameweekLifecycleScenario } = await import("./seedGameweekLifecycleScenario");
  await seedGameweekLifecycleScenario();

  runStep("playwright", "npx", [
    "playwright",
    "test",
    "--config",
    path.join("src", "testing", "recordedSmoke", "playwright.config.ts"),
  ]);

  console.log(`\n[smoke:recorded] done — artifacts in ${path.relative(repositoryRoot, recordedSmokeArtifactsRoot)}/`);
  console.log("[smoke:recorded]   report/index.html  — Playwright HTML report (steps, video, trace)");
  console.log("[smoke:recorded]   checkpoints/       — named per-checkpoint screenshots");
}

function runStep(label: string, command: string, args: string[]): void {
  console.log(`[smoke:recorded] ${label}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`[smoke:recorded] step "${label}" failed with exit code ${result.status}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
