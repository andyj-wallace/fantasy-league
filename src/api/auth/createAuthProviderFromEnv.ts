import type { AuthProvider } from "./authProvider";
import { CognitoAuthProvider } from "./cognitoAuthProvider";
import { SignedTokenAuthProvider } from "./signedTokenAuthProvider";
import { StubAuthProvider } from "./stubAuthProvider";

/** Mirrors createFootballDataProviderFromEnv — the one place that decides which AuthProvider
 * implementation is live. The default is SignedTokenAuthProvider (HMAC-signed, expiring tokens)
 * for local development; `AUTH_PROVIDER=cognito` selects the real credential check against an
 * AWS Cognito user pool (deployed environments, once the M3 CDK stack provisions the pool);
 * `AUTH_PROVIDER=stub` selects the forgeable placeholder, only for local scripts/tests. */
export function createAuthProviderFromEnv(): AuthProvider {
  if (process.env.AUTH_PROVIDER === "stub") {
    return new StubAuthProvider();
  }

  if (process.env.AUTH_PROVIDER === "cognito") {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    const appClientId = process.env.COGNITO_APP_CLIENT_ID;
    if (!userPoolId || !appClientId) {
      throw new Error("AUTH_PROVIDER=cognito requires COGNITO_USER_POOL_ID and COGNITO_APP_CLIENT_ID to be set.");
    }
    return new CognitoAuthProvider(userPoolId, appClientId);
  }

  const signingSecret = process.env.AUTH_TOKEN_SECRET;
  if (!signingSecret) {
    throw new Error(
      "AUTH_TOKEN_SECRET is required for the default signed-token auth provider. " +
        "Set it in .env, or set AUTH_PROVIDER=stub for local scripts that don't need real sessions.",
    );
  }
  return new SignedTokenAuthProvider(signingSecret);
}
