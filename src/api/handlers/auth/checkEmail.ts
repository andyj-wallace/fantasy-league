import { usersRepository } from "../../../db/repositories";
import { badRequestResponse, jsonResponse } from "../../httpResponse";
import type { ApiHandler } from "../../types";

interface CheckEmailRequestBody {
  email: string;
}

/**
 * Lets the login screen branch before submitting: known emails skip straight to login,
 * unknown emails get prompted for a display name first. Read-only — never creates a User
 * (that stays in StubAuthProvider.login, the single place sign-up happens).
 */
export const checkEmail: ApiHandler = async (event) => {
  const body = JSON.parse(event.body ?? "{}") as CheckEmailRequestBody;
  if (!body.email) return badRequestResponse("email is required");

  const existingUser = await usersRepository.findByEmail(body.email);
  return jsonResponse(200, { exists: existingUser !== null });
};
