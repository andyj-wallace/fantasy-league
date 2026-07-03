import { generateKeyPairSync, sign as signWithRsaKey, type KeyObject } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for CognitoAuthProvider's offline ID-token verification and first-login user
 * creation. No AWS or network involved: a locally generated RSA keypair plays the role of
 * Cognito's signing key, the JWKS fetch is injected, and tokens are built with exactly the
 * claim set Cognito puts in an ID token.
 */
const mocks = vi.hoisted(() => ({
  findUserByEmail: vi.fn(),
  findUserByCognitoSub: vi.fn(),
  linkCognitoIdentity: vi.fn(),
  insertUser: vi.fn(),
}));

vi.mock("../../db/repositories", () => ({
  usersRepository: {
    findByEmail: mocks.findUserByEmail,
    findByCognitoSub: mocks.findUserByCognitoSub,
    linkCognitoIdentity: mocks.linkCognitoIdentity,
    insert: mocks.insertUser,
  },
}));

import { CognitoAuthProvider } from "./cognitoAuthProvider";

const USER_POOL_ID = "eu-west-2_TestPool1";
const APP_CLIENT_ID = "test-app-client-id";
const ISSUER_URL = `https://cognito-idp.eu-west-2.amazonaws.com/${USER_POOL_ID}`;
const SIGNING_KEY_ID = "test-key-1";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: roguePrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function publishedJsonWebKeySet() {
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };
  return { keys: [{ kid: SIGNING_KEY_ID, ...jwk }] };
}

interface TokenClaimOverrides {
  sub?: string;
  iss?: string;
  aud?: string;
  token_use?: string;
  exp?: number;
  email?: string | undefined;
  email_verified?: boolean;
  name?: string;
  "cognito:username"?: string;
}

function buildIdToken(overrides: TokenClaimOverrides = {}, signingKey: KeyObject = privateKey, keyId = SIGNING_KEY_ID): string {
  const claims = {
    sub: "cognito-sub-123",
    iss: ISSUER_URL,
    aud: APP_CLIENT_ID,
    token_use: "id",
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "manager@example.com",
    email_verified: true,
    name: "Drew",
    "cognito:username": "dondangles",
    ...overrides,
  };
  const encodedHeader = Buffer.from(JSON.stringify({ kid: keyId, alg: "RS256" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = signWithRsaKey("sha256", Buffer.from(`${encodedHeader}.${encodedPayload}`), signingKey);
  return `${encodedHeader}.${encodedPayload}.${signature.toString("base64url")}`;
}

function buildProvider(fetchJsonWebKeySet = vi.fn().mockResolvedValue(publishedJsonWebKeySet())) {
  return { provider: new CognitoAuthProvider(USER_POOL_ID, APP_CLIENT_ID, fetchJsonWebKeySet), fetchJsonWebKeySet };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUserByEmail.mockResolvedValue(null);
  mocks.findUserByCognitoSub.mockResolvedValue(null);
  mocks.linkCognitoIdentity.mockResolvedValue(undefined);
  mocks.insertUser.mockImplementation(async (user) => user);
});

describe("CognitoAuthProvider — token verification", () => {
  it("resolves an already-linked user by the immutable sub, without an email lookup", async () => {
    mocks.findUserByCognitoSub.mockResolvedValue({ id: "internal-user-1", cognitoSub: "cognito-sub-123" });
    const { provider } = buildProvider();

    const session = await provider.verifySession(buildIdToken());

    expect(session).toEqual({ userId: "internal-user-1" });
    expect(mocks.findUserByEmail).not.toHaveBeenCalled();
    expect(mocks.insertUser).not.toHaveBeenCalled();
  });

  it("links a pre-existing email-matched user to their Cognito sub and handle (backfill)", async () => {
    mocks.findUserByEmail.mockResolvedValue({ id: "internal-user-1", email: "manager@example.com", cognitoSub: null });
    const { provider } = buildProvider();

    const session = await provider.verifySession(buildIdToken());

    expect(session).toEqual({ userId: "internal-user-1" });
    expect(mocks.linkCognitoIdentity).toHaveBeenCalledWith("internal-user-1", {
      cognitoSub: "cognito-sub-123",
      handle: "dondangles",
    });
    expect(mocks.insertUser).not.toHaveBeenCalled();
  });

  it("creates the User on first sight of a verified email, storing sub, handle and display name", async () => {
    const { provider } = buildProvider();

    const session = await provider.verifySession(buildIdToken({ email: "new@example.com", name: "New Manager" }));

    expect(session?.userId).toBeDefined();
    expect(mocks.insertUser).toHaveBeenCalledTimes(1);
    const [insertedUser] = mocks.insertUser.mock.calls[0]!;
    expect(insertedUser.email).toBe("new@example.com");
    expect(insertedUser.displayName).toBe("New Manager");
    expect(insertedUser.cognitoSub).toBe("cognito-sub-123");
    expect(insertedUser.handle).toBe("dondangles");
  });

  it("falls back to the email prefix as display name when the token has no name attribute", async () => {
    const { provider } = buildProvider();

    await provider.verifySession(buildIdToken({ email: "prefix@example.com", name: undefined }));

    const [insertedUser] = mocks.insertUser.mock.calls[0]!;
    expect(insertedUser.displayName).toBe("prefix");
  });

  it("resolves the winner's row when two first-ever requests race on the unique email", async () => {
    mocks.insertUser.mockRejectedValue(new Error("duplicate key value violates unique constraint"));
    mocks.findUserByEmail
      .mockResolvedValueOnce(null) // pre-insert check: not there yet
      .mockResolvedValueOnce({ id: "winner-user-id", email: "manager@example.com" }); // post-conflict re-read
    const { provider } = buildProvider();

    const session = await provider.verifySession(buildIdToken());

    expect(session).toEqual({ userId: "winner-user-id" });
  });

  it.each([
    ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["wrong audience", { aud: "some-other-client" }],
    ["wrong issuer", { iss: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_OtherPool" }],
    ["an access token, not an ID token", { token_use: "access" }],
    ["missing email", { email: undefined }],
    ["unverified email", { email_verified: false }],
  ] as [string, TokenClaimOverrides][])("rejects a token that is %s", async (_reason, overrides) => {
    const { provider } = buildProvider();

    expect(await provider.verifySession(buildIdToken(overrides))).toBeNull();
    expect(mocks.insertUser).not.toHaveBeenCalled();
  });

  it("rejects a token signed by a key the pool never published", async () => {
    const { provider } = buildProvider();

    expect(await provider.verifySession(buildIdToken({}, roguePrivateKey))).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    const { provider } = buildProvider();

    expect(await provider.verifySession("not-a-jwt")).toBeNull();
    expect(await provider.verifySession("a.b.c")).toBeNull();
    expect(await provider.verifySession("")).toBeNull();
  });
});

describe("CognitoAuthProvider — JWKS caching", () => {
  it("fetches the JWKS once and reuses it across verifications", async () => {
    mocks.findUserByEmail.mockResolvedValue({ id: "internal-user-1", email: "manager@example.com" });
    const { provider, fetchJsonWebKeySet } = buildProvider();

    await provider.verifySession(buildIdToken());
    await provider.verifySession(buildIdToken());

    expect(fetchJsonWebKeySet).toHaveBeenCalledTimes(1);
    expect(fetchJsonWebKeySet).toHaveBeenCalledWith(`${ISSUER_URL}/.well-known/jwks.json`);
  });

  it("refetches the JWKS when a token arrives signed with an unknown key id (key rotation)", async () => {
    mocks.findUserByEmail.mockResolvedValue({ id: "internal-user-1", email: "manager@example.com" });
    const { provider, fetchJsonWebKeySet } = buildProvider();

    await provider.verifySession(buildIdToken()); // fills the cache
    const tokenSignedWithUnpublishedKey = buildIdToken({}, roguePrivateKey, "rotated-key-id");
    expect(await provider.verifySession(tokenSignedWithUnpublishedKey)).toBeNull();

    // Second fetch is the rotation retry; the still-unknown key id is then rejected, not retried forever.
    expect(fetchJsonWebKeySet).toHaveBeenCalledTimes(2);
  });
});

describe("CognitoAuthProvider — construction and login", () => {
  it("rejects a user pool id it cannot derive a region from", () => {
    expect(() => new CognitoAuthProvider("not-a-pool-id", APP_CLIENT_ID, vi.fn())).toThrow(/region/i);
  });

  it("refuses login — authentication happens directly against Cognito from the client", async () => {
    const { provider } = buildProvider();

    await expect(provider.login()).rejects.toThrow(/Cognito directly from the client/);
  });
});
