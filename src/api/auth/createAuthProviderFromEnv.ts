import type { AuthProvider } from "./authProvider";
import { StubAuthProvider } from "./stubAuthProvider";

/** Mirrors apiFootballProvider.ts's createFootballDataProviderFromEnv — the one place that
 * decides which AuthProvider implementation is live. When Cognito is wired up closer to
 * deployment, this is the only function that changes (e.g. branching on AUTH_PROVIDER=cognito to
 * a new CognitoAuthProvider); every handler keeps using the AuthProvider interface unchanged. */
export function createAuthProviderFromEnv(): AuthProvider {
  return new StubAuthProvider();
}
