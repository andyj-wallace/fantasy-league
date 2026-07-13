import { Client } from "pg";

/**
 * Drops and recreates the throwaway recorded-smoke database, so every run starts from nothing —
 * several workers in the completion cascade (awardGameweekFreeTransfers, the transfer awards) are
 * deliberately not idempotent, and a fresh database is the simple way to keep re-runs honest.
 *
 * Refuses to touch any database whose name doesn't end in "_smoke", so a misconfigured URL can
 * never drop the real dev database.
 */
export async function provisionRecordedSmokeDatabase(smokeDatabaseUrl: string): Promise<void> {
  const smokeUrl = new URL(smokeDatabaseUrl);
  const smokeDatabaseName = smokeUrl.pathname.replace(/^\//, "");
  if (!smokeDatabaseName.endsWith("_smoke")) {
    throw new Error(
      `Refusing to provision "${smokeDatabaseName}" — the recorded-smoke database name must end in "_smoke"`,
    );
  }

  const maintenanceUrl = new URL(smokeDatabaseUrl);
  maintenanceUrl.pathname = "/postgres";

  const client = new Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(smokeDatabaseName)} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoteIdentifier(smokeDatabaseName)}`);
  } finally {
    await client.end();
  }
  console.log(`[provisionRecordedSmokeDatabase] recreated database "${smokeDatabaseName}"`);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
