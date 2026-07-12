import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

const LOCAL_DATABASE_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/** RDS server certificates chain to Amazon's private CA, which is not in Node's default trust
 * store — the regional bundle is committed next to this file and copied into the Lambda bundle
 * by the infra build. Only read when connecting to a non-local database. */
function loadRdsCertificateAuthorityBundle(): string {
  return readFileSync(join(__dirname, "rds-us-east-1-ca-bundle.pem"), "utf8");
}

function buildPoolConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  const config: PoolConfig = { connectionString };

  if (!connectionString || connectionString.includes("sslmode=disable")) return config;

  // libpq's "require": encrypted but unverified. Used for admin/seed connections through the
  // SSM port-forward tunnel, where RDS still demands TLS (rds.force_ssl) but the server cert
  // (issued for the RDS hostname) can never match the tunnel's localhost endpoint. The marker
  // is stripped before pg sees the string — pg's own sslmode parsing would override this
  // explicit ssl config with a verifying one.
  if (connectionString.includes("sslmode=require")) {
    config.connectionString = connectionString.replace(/[?&]sslmode=require/, "");
    config.ssl = { rejectUnauthorized: false };
    return config;
  }

  if (LOCAL_DATABASE_HOSTNAMES.has(new URL(connectionString).hostname)) return config;

  config.ssl = { ca: loadRdsCertificateAuthorityBundle(), rejectUnauthorized: true };
  // Lambda scales by running more concurrent instances, each with its own pool, so every pool
  // stays tiny to keep the total RDS connection count bounded.
  config.max = 2;
  return config;
}

const pool = new Pool(buildPoolConfig());

export const db = drizzle(pool, { schema });

/** Drizzle database client or an active transaction — pass as an optional param to repository
 * functions so they can participate in a caller-owned transaction without nesting. */
export type DbOrTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
