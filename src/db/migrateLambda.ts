import { join } from "node:path";
import type { Handler } from "aws-lambda";
import { loadRuntimeConfigFromSsm } from "../runtimeConfig/loadRuntimeConfigFromSsm";

interface MigrationResult {
  status: "migrations-applied";
  appliedMigrationCount: number;
  publicTableCount: number;
  appRoleEnsured: boolean;
}

/** Name of the least-privilege Postgres role the API and worker Lambdas connect as — DML on the
 * app tables only, so the RDS master credential never sits in the app's runtime path. */
const APP_DATABASE_ROLE_NAME = "fantasy_app";

/**
 * Runs the Drizzle migrations against the deployed database. Invoked manually (or by CI)
 * after each deploy — it exists because the RDS instance is private, so neither a laptop
 * nor CI can run `db:migrate` against it directly. The migrations SQL + journal are copied
 * into the Lambda bundle by the infra build.
 */
export const handler: Handler<unknown, MigrationResult> = async () => {
  await loadRuntimeConfigFromSsm();

  // The db pool reads DATABASE_URL at import time, so import only after config is loaded.
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const { sql } = await import("drizzle-orm");
  const { db } = await import("./client");

  await migrate(db, { migrationsFolder: join(__dirname, "migrations") });

  const appRolePassword = process.env.DB_APP_ROLE_PASSWORD;
  if (appRolePassword) {
    await ensureAppDatabaseRole(db, sql, appRolePassword);
  }

  const appliedMigrations = await db.execute(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
  );
  const publicTables = await db.execute(
    sql`select count(*)::int as count from information_schema.tables where table_schema = 'public'`,
  );

  return {
    status: "migrations-applied",
    appliedMigrationCount: Number(appliedMigrations.rows[0]?.count ?? 0),
    publicTableCount: Number(publicTables.rows[0]?.count ?? 0),
    appRoleEnsured: Boolean(appRolePassword),
  };
};

/** Creates (or re-passwords) the app role and grants it DML on everything in `public` — including
 * tables added by future migrations, via ALTER DEFAULT PRIVILEGES on the migrating master role. */
async function ensureAppDatabaseRole(
  db: (typeof import("./client"))["db"],
  sql: (typeof import("drizzle-orm"))["sql"],
  appRolePassword: string,
): Promise<void> {
  const quotedPassword = `'${appRolePassword.replace(/'/g, "''")}'`;
  const statements = [
    `DO $$ BEGIN CREATE ROLE ${APP_DATABASE_ROLE_NAME} LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `ALTER ROLE ${APP_DATABASE_ROLE_NAME} LOGIN PASSWORD ${quotedPassword}`,
    `GRANT USAGE ON SCHEMA public TO ${APP_DATABASE_ROLE_NAME}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_DATABASE_ROLE_NAME}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_DATABASE_ROLE_NAME}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_DATABASE_ROLE_NAME}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_DATABASE_ROLE_NAME}`,
  ];
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}
