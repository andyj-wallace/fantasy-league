import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";

/** Maps each SSM parameter name (relative to the config path) to the env var the app reads. */
const PARAMETER_NAME_TO_ENV_VAR: Record<string, string> = {
  "auth-token-secret": "AUTH_TOKEN_SECRET",
  "football-data-api-key": "FOOTBALL_DATA_API_KEY",
  "cognito-user-pool-id": "COGNITO_USER_POOL_ID",
  "cognito-app-client-id": "COGNITO_APP_CLIENT_ID",
  // Only the migration Lambda uses this: it provisions/updates the least-privilege app role.
  "db-app-password": "DB_APP_ROLE_PASSWORD",
};

/**
 * Deployed Lambdas get their secrets from SSM SecureString parameters under
 * `SSM_CONFIG_PATH` (e.g. /fantasy-league/prod), because CloudFormation cannot inject
 * SecureString values as Lambda env vars. Called once per cold start, before any module
 * that reads config at import time (db pool, auth provider) is loaded — entrypoints must
 * therefore dynamic-import the rest of the app after awaiting this.
 *
 * DATABASE_URL is composed here from the `db-password` parameter plus the plain
 * DB_HOST / DB_PORT / DB_NAME / DB_USER env vars the CDK stack injects.
 *
 * No-op when SSM_CONFIG_PATH is unset (local dev reads .env instead).
 */
export async function loadRuntimeConfigFromSsm(): Promise<void> {
  const configPath = process.env.SSM_CONFIG_PATH;
  if (!configPath) return;

  const parametersByRelativeName = await fetchAllParametersUnderPath(configPath);

  for (const [parameterName, envVarName] of Object.entries(PARAMETER_NAME_TO_ENV_VAR)) {
    const value = parametersByRelativeName[parameterName];
    if (value !== undefined) process.env[envVarName] = value;
  }

  // Which password parameter to compose DATABASE_URL with: the migration Lambda connects as
  // the master role ("db-password"); the API and workers as the app role ("db-app-password").
  const passwordParameterName = process.env.DB_PASSWORD_PARAMETER ?? "db-password";
  const databasePassword = parametersByRelativeName[passwordParameterName];
  const databaseHost = process.env.DB_HOST;
  if (databasePassword !== undefined && databaseHost !== undefined) {
    const user = process.env.DB_USER ?? "postgres";
    const port = process.env.DB_PORT ?? "5432";
    const databaseName = process.env.DB_NAME ?? "postgres";
    process.env.DATABASE_URL = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(databasePassword)}@${databaseHost}:${port}/${databaseName}`;
  }
}

async function fetchAllParametersUnderPath(configPath: string): Promise<Record<string, string>> {
  const ssmClient = new SSMClient({});
  const parametersByRelativeName: Record<string, string> = {};
  let nextToken: string | undefined;

  do {
    const page = await ssmClient.send(
      new GetParametersByPathCommand({ Path: configPath, WithDecryption: true, NextToken: nextToken }),
    );
    for (const parameter of page.Parameters ?? []) {
      if (!parameter.Name || parameter.Value === undefined) continue;
      const relativeName = parameter.Name.slice(configPath.length).replace(/^\//, "");
      parametersByRelativeName[relativeName] = parameter.Value;
    }
    nextToken = page.NextToken;
  } while (nextToken);

  return parametersByRelativeName;
}
