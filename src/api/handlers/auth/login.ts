import { randomUUID } from "node:crypto";
import { usersRepository } from "../../../db/repositories";
import { badRequestResponse, jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface LoginRequestBody {
  email: string;
  displayName?: string;
}

/**
 * Mock-only stub: there's no real credential check yet, so login doubles as signup — an unknown
 * email creates a User on the spot. Real authentication is a deliberate follow-up, not this pass.
 */
export const login: ApiHandler = async (event) => {
  const body = JSON.parse(event.body ?? "{}") as LoginRequestBody;
  if (!body.email) return badRequestResponse("email is required");

  const existingUser = await usersRepository.findByEmail(body.email);
  const user =
    existingUser ??
    (await usersRepository.insert({
      id: randomUUID(),
      email: body.email,
      displayName: body.displayName || body.email.split("@")[0]!,
      createdAt: new Date(),
    }));

  return jsonResponse(200, { userId: user.id, email: user.email, displayName: user.displayName, token: "stub-session-token" });
};
