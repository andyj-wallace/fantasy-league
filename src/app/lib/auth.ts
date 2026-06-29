const STORED_USER_ID_KEY = "userId";
const STORED_TOKEN_KEY = "token";

export function getStoredUserId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORED_USER_ID_KEY);
}

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORED_TOKEN_KEY);
}

export function setStoredSession(session: { userId: string; token: string }): void {
  window.localStorage.setItem(STORED_USER_ID_KEY, session.userId);
  window.localStorage.setItem(STORED_TOKEN_KEY, session.token);
}

export function clearStoredSession(): void {
  window.localStorage.removeItem(STORED_USER_ID_KEY);
  window.localStorage.removeItem(STORED_TOKEN_KEY);
}
