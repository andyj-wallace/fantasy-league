/**
 * Input validation shared by the login and check-email handlers. Kept intentionally small — this
 * guards against malformed/oversized input reaching the (passwordless) auth provider; it is not a
 * substitute for the real credential checks a CognitoAuthProvider will bring later.
 */

const MAX_EMAIL_LENGTH = 254; // RFC 5321 practical maximum
const MAX_DISPLAY_NAME_LENGTH = 60;
/** Deliberately permissive shape check ("something@something.something"), not full RFC 5322. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns a human-readable reason the email is invalid, or null if it's acceptable. */
export function validateEmail(email: unknown): string | null {
  if (typeof email !== "string" || email.length === 0) return "email is required";
  if (email.length > MAX_EMAIL_LENGTH) return "email is too long";
  if (!EMAIL_PATTERN.test(email)) return "email is not a valid address";
  return null;
}

/** Returns a reason the (optional) display name is invalid, or null if acceptable/absent. */
export function validateDisplayName(displayName: unknown): string | null {
  if (displayName === undefined || displayName === null) return null; // optional
  if (typeof displayName !== "string") return "displayName must be a string";
  if (displayName.trim().length === 0) return "displayName cannot be blank";
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) return "displayName is too long";
  return null;
}
