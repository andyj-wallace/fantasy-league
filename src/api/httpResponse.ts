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
