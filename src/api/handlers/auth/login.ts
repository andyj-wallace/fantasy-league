import { usersRepository } from "../../../db/repositories";
import { authProvider } from "../../auth";
import { validateDisplayName, validateEmail } from "../../auth/credentialValidation";
import { registerLoginAttempt } from "../../auth/loginRateLimiter";
import { badRequestResponse, jsonResponse, tooManyRequestsResponse } from "../../httpResponse";
import type { ApiHandler, ApiHandlerEvent } from "../../types";

interface LoginRequestBody {
  email: string;
  displayName?: string;
}

/** Best-effort caller identity for rate limiting: the client IP if the proxy forwarded it, else "unknown". */
function callerIp(event: ApiHandlerEvent): string {
  const forwardedFor = event.headers?.["x-forwarded-for"] ?? event.headers?.["X-Forwarded-For"];
  return forwardedFor?.split(",")[0]?.trim() || "unknown";
}

/**
 * Mock-only stub: there's no real credential check yet, so login doubles as signup — an unknown
 * email creates a User on the spot (see StubAuthProvider). Real authentication is a deliberate
 * follow-up, not this pass — but it's now behind the AuthProvider boundary so that follow-up is
 * a new implementation, not a rewrite of this handler.
 */
export const login: ApiHandler = async (event) => {
  const body = JSON.parse(event.body ?? "{}") as LoginRequestBody;

  const emailError = validateEmail(body.email);
  if (emailError) return badRequestResponse(emailError);
  const displayNameError = validateDisplayName(body.displayName);
  if (displayNameError) return badRequestResponse(displayNameError);

  // Rate-limit per targeted account and per source IP, so neither a single-account brute force nor
  // a spray across accounts from one host runs unbounded.
  for (const key of [`email:${body.email.toLowerCase()}`, `ip:${callerIp(event)}`]) {
    const { allowed, retryAfterSeconds } = registerLoginAttempt(key);
    if (!allowed) return tooManyRequestsResponse(retryAfterSeconds);
  }

  const { userId, token } = await authProvider.login({ email: body.email, displayName: body.displayName });
  const user = await usersRepository.findById(userId);
  return jsonResponse(200, { userId, email: user!.email, displayName: user!.displayName, token });
};
