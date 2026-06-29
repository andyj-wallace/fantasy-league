import { randomUUID } from "node:crypto";
import { usersRepository } from "../../db/repositories";
import type { AuthProvider, AuthSession } from "./authProvider";

const TOKEN_PREFIX = "stub.";

/**
 * No real credential check — an unknown email creates a User on the spot, same as today's
 * behavior, just moved behind the AuthProvider boundary. The token is deliberately an unsigned
 * placeholder (`stub.<userId>`), not a JWT: this whole class is what gets replaced by a
 * CognitoAuthProvider later, without any handler needing to change.
 */
export class StubAuthProvider implements AuthProvider {
  async login(credentials: { email: string; displayName?: string }): Promise<{ userId: string; token: string }> {
    const existingUser = await usersRepository.findByEmail(credentials.email);
    const user =
      existingUser ??
      (await usersRepository.insert({
        id: randomUUID(),
        email: credentials.email,
        displayName: credentials.displayName || credentials.email.split("@")[0]!,
        createdAt: new Date(),
      }));

    return { userId: user.id, token: `${TOKEN_PREFIX}${user.id}` };
  }

  async verifySession(token: string): Promise<AuthSession | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const userId = token.slice(TOKEN_PREFIX.length);
    const user = await usersRepository.findById(userId);
    return user ? { userId: user.id } : null;
  }
}
