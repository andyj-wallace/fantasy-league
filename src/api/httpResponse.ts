import type { ApiHandlerResult } from "./types";

export function jsonResponse(statusCode: number, body: unknown): ApiHandlerResult {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function emptyResponse(statusCode: number): ApiHandlerResult {
  return { statusCode, body: "" };
}

export function notFoundResponse(message = "Not found"): ApiHandlerResult {
  return jsonResponse(404, { message });
}

export function badRequestResponse(message: string): ApiHandlerResult {
  return jsonResponse(400, { message });
}

export function unauthorizedResponse(message = "Missing or invalid session"): ApiHandlerResult {
  return jsonResponse(401, { message });
}

export function forbiddenResponse(message = "Not allowed to modify this resource"): ApiHandlerResult {
  return jsonResponse(403, { message });
}

export function conflictResponse(message: string): ApiHandlerResult {
  return jsonResponse(409, { message });
}

export function tooManyRequestsResponse(retryAfterSeconds: number, message = "Too many attempts, try again shortly"): ApiHandlerResult {
  return {
    statusCode: 429,
    headers: { "content-type": "application/json", "retry-after": String(retryAfterSeconds) },
    body: JSON.stringify({ message }),
  };
}
