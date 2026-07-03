import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import { clearStoredSession, setStoredSession } from "./auth";

/**
 * Browser-side Cognito authentication (decided 2026-07-03: users pick a unique handle at
 * sign-up — the Cognito username — set a password, and can log in with either the handle or
 * their verified email, which the alias-mode user pool resolves; the pre-verification
 * confirmation flows address the account by handle). The browser talks to the user pool
 * directly — the API never sees a password — and the resulting **ID token** is what authedFetch
 * sends as the bearer token, verified server-side by CognitoAuthProvider (which keys on the
 * verified email claim, so it is untouched by the handle model). amazon-cognito-identity-js
 * keeps the id/access/refresh tokens in its own localStorage entries; we mirror the current ID
 * token into the app's stored session so the existing synchronous logged-in checks keep working
 * unchanged.
 *
 * Cognito mode is a build-time switch: it is active when both NEXT_PUBLIC_COGNITO_* values are
 * present (deployed builds), and absent in local dev, where the legacy email-only login against
 * the signed-token provider remains the flow.
 */
const userPoolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
const appClientId = process.env.NEXT_PUBLIC_COGNITO_APP_CLIENT_ID;

export function isCognitoAuthEnabled(): boolean {
  return Boolean(userPoolId && appClientId);
}

function requireUserPool(): CognitoUserPool {
  if (!userPoolId || !appClientId) {
    throw new Error("Cognito auth is not configured — set NEXT_PUBLIC_COGNITO_USER_POOL_ID and NEXT_PUBLIC_COGNITO_APP_CLIENT_ID.");
  }
  return new CognitoUserPool({ UserPoolId: userPoolId, ClientId: appClientId });
}

/** The identifier can be the handle (always works) or the email (works once verified — Cognito
 * only activates the email alias after verification, so pre-confirmation flows use the handle). */
function cognitoUserForIdentifier(handleOrEmail: string): CognitoUser {
  return new CognitoUser({ Username: handleOrEmail, Pool: requireUserPool() });
}

const HANDLE_FORMAT = /^[a-zA-Z0-9._-]{3,30}$/;

/** Client-side pre-check so a bad handle gets a clear message instead of Cognito's generic
 * "username cannot be of email format" / validation errors. Handles are case-insensitive at
 * login (the pool is configured CaseSensitive=false). */
export function validateHandleFormat(handle: string): string | null {
  if (!HANDLE_FORMAT.test(handle)) {
    return "Handles are 3–30 characters using letters, numbers, dots, dashes or underscores — no spaces or @.";
  }
  return null;
}

/** Mirrors the session's current ID token into the app's stored session (see module comment). */
function storeIdTokenFromSession(session: CognitoUserSession): void {
  const idToken = session.getIdToken();
  setStoredSession({ userId: idToken.payload.sub as string, token: idToken.getJwtToken() });
}

export function signUpWithCognito(handle: string, email: string, displayName: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    requireUserPool().signUp(
      handle,
      password,
      [
        new CognitoUserAttribute({ Name: "email", Value: email }),
        // The pool schema (fixed at creation) requires preferred_username and given_name in
        // addition to the standard name attribute — fill them from the handle and display name.
        new CognitoUserAttribute({ Name: "preferred_username", Value: handle }),
        new CognitoUserAttribute({ Name: "name", Value: displayName }),
        new CognitoUserAttribute({ Name: "given_name", Value: displayName }),
      ],
      [],
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export function confirmCognitoSignUp(handleOrEmail: string, confirmationCode: string): Promise<void> {
  return new Promise((resolve, reject) => {
    cognitoUserForIdentifier(handleOrEmail).confirmRegistration(confirmationCode, true, (error) => (error ? reject(error) : resolve()));
  });
}

export function resendCognitoConfirmationCode(handleOrEmail: string): Promise<void> {
  return new Promise((resolve, reject) => {
    cognitoUserForIdentifier(handleOrEmail).resendConfirmationCode((error) => (error ? reject(error) : resolve()));
  });
}

export function loginWithCognito(handleOrEmail: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    cognitoUserForIdentifier(handleOrEmail).authenticateUser(
      new AuthenticationDetails({ Username: handleOrEmail, Password: password }),
      {
        onSuccess: (session) => {
          storeIdTokenFromSession(session);
          resolve();
        },
        onFailure: reject,
      },
    );
  });
}

export function requestCognitoPasswordReset(handleOrEmail: string): Promise<void> {
  return new Promise((resolve, reject) => {
    cognitoUserForIdentifier(handleOrEmail).forgotPassword({ onSuccess: () => resolve(), onFailure: reject });
  });
}

export function confirmCognitoPasswordReset(handleOrEmail: string, confirmationCode: string, newPassword: string): Promise<void> {
  return new Promise((resolve, reject) => {
    cognitoUserForIdentifier(handleOrEmail).confirmPassword(confirmationCode, newPassword, {
      onSuccess: () => resolve(),
      onFailure: reject,
    });
  });
}

/**
 * The current ID token for API calls, transparently refreshed via the stored refresh token when
 * expired (getSession handles that) — so the hour-scale ID-token lifetime never logs users out
 * mid-session. Null when nobody is signed in or the refresh token itself has expired.
 */
export function getFreshCognitoIdToken(): Promise<string | null> {
  const currentUser = requireUserPool().getCurrentUser();
  if (!currentUser) return Promise.resolve(null);

  return new Promise((resolve) => {
    currentUser.getSession((error: Error | null, session: CognitoUserSession | null) => {
      if (error || !session || !session.isValid()) {
        resolve(null);
        return;
      }
      storeIdTokenFromSession(session);
      resolve(session.getIdToken().getJwtToken());
    });
  });
}

/** Logs out of whichever auth mode is active: revokes the local Cognito session (when enabled)
 * and clears the app's stored session. The two logout buttons call this instead of
 * clearStoredSession directly. */
export function logOut(): void {
  if (isCognitoAuthEnabled()) {
    requireUserPool().getCurrentUser()?.signOut();
  }
  clearStoredSession();
}
