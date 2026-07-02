import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the HMAC-signed session token. usersRepository is mocked so these run without a
 * database: they exercise the token issue → verify round-trip and, crucially, that tampered and
 * expired tokens are rejected before any user lookup.
 */
const mocks = vi.hoisted(() => ({
  findByEmail: vi.fn(),
  findById: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("../../db/repositories", () => ({
  usersRepository: { findByEmail: mocks.findByEmail, findById: mocks.findById, insert: mocks.insert },
}));

import { SignedTokenAuthProvider } from "./signedTokenAuthProvider";

const SECRET = "test-signing-secret";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockImplementation(async (id: string) => ({ id, email: "u@example.com", displayName: "U" }));
});

describe("SignedTokenAuthProvider — construction", () => {
  it("throws when constructed without a secret", () => {
    expect(() => new SignedTokenAuthProvider("")).toThrow(/signing secret/i);
  });
});

describe("SignedTokenAuthProvider — issue and verify", () => {
  it("issues a token that verifies back to the same user", async () => {
    mocks.findByEmail.mockResolvedValue({ id: "user-1", email: "u@example.com", displayName: "U" });
    const provider = new SignedTokenAuthProvider(SECRET);

    const { userId, token } = await provider.login({ email: "u@example.com" });
    const session = await provider.verifySession(token);

    expect(userId).toBe("user-1");
    expect(session).toEqual({ userId: "user-1" });
  });

  it("creates the user on first login (passwordless signup)", async () => {
    mocks.findByEmail.mockResolvedValue(null);
    mocks.insert.mockImplementation(async (user) => user);
    const provider = new SignedTokenAuthProvider(SECRET);

    const { token } = await provider.login({ email: "new@example.com", displayName: "New" });

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(await provider.verifySession(token)).not.toBeNull();
  });
});

describe("SignedTokenAuthProvider — rejects bad tokens", () => {
  it("rejects a token signed with a different secret", async () => {
    mocks.findByEmail.mockResolvedValue({ id: "user-1", email: "u@example.com", displayName: "U" });
    const issuer = new SignedTokenAuthProvider("secret-A");
    const verifier = new SignedTokenAuthProvider("secret-B");

    const { token } = await issuer.login({ email: "u@example.com" });

    expect(await verifier.verifySession(token)).toBeNull();
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it("rejects a token whose payload was tampered with", async () => {
    mocks.findByEmail.mockResolvedValue({ id: "user-1", email: "u@example.com", displayName: "U" });
    const provider = new SignedTokenAuthProvider(SECRET);
    const { token } = await provider.login({ email: "u@example.com" });

    // Swap in a forged payload (different userId) while keeping the original signature.
    const [, signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ userId: "attacker", exp: 9999999999 })).toString("base64url");
    const forgedToken = `${forgedPayload}.${signature}`;

    expect(await provider.verifySession(forgedToken)).toBeNull();
  });

  it("rejects an expired token", async () => {
    mocks.findByEmail.mockResolvedValue({ id: "user-1", email: "u@example.com", displayName: "U" });
    const provider = new SignedTokenAuthProvider(SECRET, -1); // already expired on issue

    const { token } = await provider.login({ email: "u@example.com" });

    expect(await provider.verifySession(token)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    const provider = new SignedTokenAuthProvider(SECRET);

    expect(await provider.verifySession("not-a-token")).toBeNull();
    expect(await provider.verifySession("")).toBeNull();
  });
});
