const STORED_USER_ID_KEY = "userId";

export function getStoredUserId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORED_USER_ID_KEY);
}

export function setStoredUserId(userId: string): void {
  window.localStorage.setItem(STORED_USER_ID_KEY, userId);
}
