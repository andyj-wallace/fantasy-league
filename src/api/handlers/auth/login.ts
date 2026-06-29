import { usersRepository } from "../../../db/repositories";
import { authProvider } from "../../auth";
import { badRequestResponse, jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface LoginRequestBody {
  email: string;
  displayName?: string;
}

/**
 * Mock-only stub: there's no real credential check yet, so login doubles as signup — an unknown
 * email creates a User on the spot (see StubAuthProvider). Real authentication is a deliberate
 * follow-up, not this pass — but it's now behind the AuthProvider boundary so that follow-up is
 * a new implementation, not a rewrite of this handler.
 */
export const login: ApiHandler = async (event) => {
  const body = JSON.parse(event.body ?? "{}") as LoginRequestBody;
  if (!body.email) return badRequestResponse("email is required");

  const { userId, token } = await authProvider.login({ email: body.email, displayName: body.displayName });
  const user = await usersRepository.findById(userId);
  return jsonResponse(200, { userId, email: user!.email, displayName: user!.displayName, token });
};
