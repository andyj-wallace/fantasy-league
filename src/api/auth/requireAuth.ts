import { unauthorizedResponse } from "../httpResponse";
import type { ApiHandler, ApiHandlerEvent, ApiHandlerResult } from "../types";
import { authProvider } from "./authProviderInstance";
import type { AuthSession } from "./authProvider";

export type AuthenticatedApiHandler = (event: ApiHandlerEvent, session: AuthSession) => Promise<ApiHandlerResult>;

function extractBearerToken(headers: ApiHandlerEvent["headers"]): string | null {
  const header = headers?.authorization ?? headers?.Authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/** Wraps a handler so it only runs once the request carries a valid session — every mutating
 * route goes through this rather than trusting a client-supplied user/team/league ID directly. */
export function requireAuth(handler: AuthenticatedApiHandler): ApiHandler {
  return async (event) => {
    const token = extractBearerToken(event.headers);
    if (!token) return unauthorizedResponse();

    const session = await authProvider.verifySession(token);
    if (!session) return unauthorizedResponse();

    return handler(event, session);
  };
}
