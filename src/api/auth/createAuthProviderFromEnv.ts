import type { AuthProvider } from "./authProvider";
import { SignedTokenAuthProvider } from "./signedTokenAuthProvider";
import { StubAuthProvider } from "./stubAuthProvider";

/** Mirrors apiFootballProvider.ts's createFootballDataProviderFromEnv — the one place that
 * decides which AuthProvider implementation is live. The default is SignedTokenAuthProvider
 * (HMAC-signed, expiring tokens); `AUTH_PROVIDER=stub` selects the forgeable placeholder, only
 * for local scripts/tests. When Cognito is wired up closer to deployment, this stays the only
 * function that changes (adding an `AUTH_PROVIDER=cognito` branch), with every handler keeping
 * the AuthProvider interface unchanged. */
export function createAuthProviderFromEnv(): AuthProvider {
  if (process.env.AUTH_PROVIDER === "stub") {
    return new StubAuthProvider();
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
