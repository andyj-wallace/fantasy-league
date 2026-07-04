import type { AuthProvider } from "./authProvider";
import { CognitoAuthProvider } from "./cognitoAuthProvider";
import { SignedTokenAuthProvider } from "./signedTokenAuthProvider";
import { StubAuthProvider } from "./stubAuthProvider";

/** Mirrors createFootballDataProviderFromEnv — the one place that decides which AuthProvider
 * implementation is live. `AUTH_PROVIDER=cognito` is the standard mode everywhere, local dev
 * included: the real credential check against the AWS Cognito user pool. With AUTH_PROVIDER
 * unset the fallback is SignedTokenAuthProvider (HMAC-signed, expiring tokens; passwordless) for
 * offline work; `AUTH_PROVIDER=stub` selects the forgeable placeholder, only for scripts/tests. */
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
