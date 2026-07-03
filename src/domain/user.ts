/** An account holder who can create/join leagues and own a Team in each. */
export interface User {
  id: string;
  email: string;
  displayName: string;
  /** Immutable Cognito account id (the ID token's `sub` claim) — the stable identity link, since
   * emails are mutable in Cognito. Null until the user's first Cognito login (and forever for
   * local-dev users on the signed-token provider). */
  cognitoSub: string | null;
  /** The user's unique login handle (the Cognito username, e.g. "dondangles") — a synced copy
   * for display and queries; Cognito remains the source of truth. Null for local-dev users. */
  handle: string | null;
  createdAt: Date;
}
