export interface AuthSession {
  userId: string;
}

/**
 * Boundary between our API and whatever issues/verifies identity. StubAuthProvider is the only
 * implementation today; a CognitoAuthProvider is the planned swap closer to deployment — every
 * handler goes through this interface (never `usersRepository` or a raw token directly), so that
 * swap touches this file only, not the handlers.
 */
export interface AuthProvider {
  /** Issues a session for the given credentials, creating the User on first login if needed. */
  login(credentials: { email: string; displayName?: string }): Promise<{ userId: string; token: string }>;
  /** Verifies a bearer token, returning the session it represents or null if invalid/expired. */
  verifySession(token: string): Promise<AuthSession | null>;
}
