import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { usersRepository } from "../../db/repositories";
import type { AuthProvider, AuthSession } from "./authProvider";

const DEFAULT_TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 7; // one week

interface SignedTokenPayload {
  userId: string;
  /** Unix epoch seconds after which the token is rejected. */
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * A drop-in replacement for StubAuthProvider that issues HMAC-signed, time-bounded tokens instead
 * of the forgeable `stub.<userId>` placeholder. The wire format is `<base64url(payload)>.<base64url(signature)>`;
 * verifySession recomputes the signature with the shared secret and rejects tokens that are tampered
 * with or past their `exp`. Login is still passwordless (email → User, created on first sight) — this
 * class only hardens the *session token*, not the credential model; a real credential check (Cognito)
 * remains the later swap behind the unchanged AuthProvider interface.
 */
export class SignedTokenAuthProvider implements AuthProvider {
  private readonly signingSecret: string;
  private readonly tokenLifetimeSeconds: number;

  constructor(signingSecret: string, tokenLifetimeSeconds: number = DEFAULT_TOKEN_LIFETIME_SECONDS) {
    if (!signingSecret) {
      throw new Error("SignedTokenAuthProvider requires a non-empty signing secret (set AUTH_TOKEN_SECRET).");
    }
    this.signingSecret = signingSecret;
    this.tokenLifetimeSeconds = tokenLifetimeSeconds;
  }

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

    return { userId: user.id, token: this.issueToken(user.id) };
  }

  async verifySession(token: string): Promise<AuthSession | null> {
    const payload = this.verifyAndDecode(token);
    if (!payload) return null;

    const user = await usersRepository.findById(payload.userId);
    return user ? { userId: user.id } : null;
  }

  private issueToken(userId: string): string {
    const payload: SignedTokenPayload = {
      userId,
      exp: Math.floor(Date.now() / 1000) + this.tokenLifetimeSeconds,
    };
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    return `${encodedPayload}.${this.sign(encodedPayload)}`;
  }

  /** Returns the payload only if the signature is valid and the token has not expired. */
  private verifyAndDecode(token: string): SignedTokenPayload | null {
    const [encodedPayload, providedSignature] = token.split(".");
    if (!encodedPayload || !providedSignature) return null;
    if (!this.signaturesMatch(this.sign(encodedPayload), providedSignature)) return null;

    let payload: SignedTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString()) as SignedTokenPayload;
    } catch {
      return null;
    }

    if (typeof payload.userId !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null; // expired
    return payload;
  }

  private sign(encodedPayload: string): string {
    return createHmac("sha256", this.signingSecret).update(encodedPayload).digest("base64url");
  }

  /** Constant-time comparison so a mismatch's timing doesn't leak how much of the signature was right. */
  private signaturesMatch(expected: string, provided: string): boolean {
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    if (expectedBuffer.length !== providedBuffer.length) return false;
    return timingSafeEqual(expectedBuffer, providedBuffer);
  }
}
