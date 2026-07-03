import { createPublicKey, randomUUID, verify as verifyRsaSignature, type KeyObject } from "node:crypto";
import { usersRepository } from "../../db/repositories";
import type { AuthProvider, AuthSession } from "./authProvider";

/** The subset of a JSON Web Key this provider needs to verify an RS256 signature. */
interface CognitoJsonWebKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

export type FetchJsonWebKeySet = (jwksUrl: string) => Promise<{ keys: CognitoJsonWebKey[] }>;

/** The Cognito ID-token claims this provider reads (see AWS "Verifying a JSON Web Token"). */
interface CognitoIdTokenClaims {
  sub: string;
  iss: string;
  aud: string;
  token_use: string;
  exp: number;
  email: string;
  email_verified: boolean;
  /** The user's display name, collected as the standard `name` attribute at sign-up. */
  name?: string;
  /** The user's login handle — the Cognito username they picked at sign-up. */
  "cognito:username"?: string;
}

async function fetchJsonWebKeySetOverHttp(jwksUrl: string): Promise<{ keys: CognitoJsonWebKey[] }> {
  const response = await fetch(jwksUrl);
  if (!response.ok) throw new Error(`Fetching Cognito JWKS failed: ${response.status} ${response.statusText}`);
  return (await response.json()) as { keys: CognitoJsonWebKey[] };
}

/**
 * The real-credential AuthProvider (decided 2026-07-03: email + password via Cognito's native
 * flow). Authentication itself happens directly between the browser and Cognito — the client
 * signs up / logs in against the user pool and sends the resulting **ID token** as its bearer
 * token; this provider only verifies that token offline against the pool's published JWKS
 * (RS256 signature, expiry, issuer, audience, token_use, verified email) and resolves it to an
 * internal User row — primarily by the immutable `sub` claim, falling back to email once to link
 * pre-existing rows. The User is created on first sight of a Cognito-verified email, storing the
 * sub, the login handle (`cognito:username`), and the display name from the `name` attribute.
 *
 * Verification needs no AWS SDK or network round-trip per request: the JWKS is fetched once and
 * cached, refetched only when a token arrives signed with an unknown key id (key rotation).
 */
export class CognitoAuthProvider implements AuthProvider {
  private readonly issuerUrl: string;
  private cachedPublicKeysByKeyId: Map<string, KeyObject> | null = null;

  constructor(
    userPoolId: string,
    private readonly appClientId: string,
    private readonly fetchJsonWebKeySet: FetchJsonWebKeySet = fetchJsonWebKeySetOverHttp,
  ) {
    const region = userPoolId.split("_")[0];
    if (!region || !userPoolId.includes("_")) {
      throw new Error(`COGNITO_USER_POOL_ID must look like "<region>_<id>" (e.g. eu-west-2_AbCdEfGhI), got "${userPoolId}"`);
    }
    this.issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  }

  /** Login never reaches the API with Cognito — the browser authenticates against the user pool
   * directly and the API only ever sees tokens. Kept only to satisfy the AuthProvider interface. */
  async login(): Promise<{ userId: string; token: string }> {
    throw new Error("Login is handled by Cognito directly from the client; the API only verifies Cognito ID tokens.");
  }

  async verifySession(token: string): Promise<AuthSession | null> {
    const claims = await this.verifyAndDecodeIdToken(token);
    if (!claims) return null;

    // The immutable `sub` is the primary identity link — emails are mutable in Cognito, so an
    // email-keyed lookup alone would mint a duplicate User after an email change.
    const existingUserBySub = await usersRepository.findByCognitoSub(claims.sub);
    if (existingUserBySub) return { userId: existingUserBySub.id };

    const handle = claims["cognito:username"] ?? null;
    const existingUserByEmail = await usersRepository.findByEmail(claims.email);
    if (existingUserByEmail) {
      // A row from before the sub/handle columns existed (or from the dev providers) — link it.
      await usersRepository.linkCognitoIdentity(existingUserByEmail.id, { cognitoSub: claims.sub, handle });
      return { userId: existingUserByEmail.id };
    }

    try {
      const createdUser = await usersRepository.insert({
        id: randomUUID(),
        email: claims.email,
        displayName: claims.name || claims.email.split("@")[0]!,
        cognitoSub: claims.sub,
        handle,
        createdAt: new Date(),
      });
      return { userId: createdUser.id };
    } catch {
      // Two first-ever requests raced on the unique email — the loser re-reads the winner's row.
      const userInsertedByConcurrentRequest = await usersRepository.findByEmail(claims.email);
      return userInsertedByConcurrentRequest ? { userId: userInsertedByConcurrentRequest.id } : null;
    }
  }

  private async verifyAndDecodeIdToken(token: string): Promise<CognitoIdTokenClaims | null> {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

    let keyId: string;
    let claims: CognitoIdTokenClaims;
    try {
      const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString()) as { kid?: string; alg?: string };
      if (header.alg !== "RS256" || !header.kid) return null;
      keyId = header.kid;
      claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString()) as CognitoIdTokenClaims;
    } catch {
      return null;
    }

    const publicKey = await this.resolvePublicKey(keyId);
    if (!publicKey) return null;

    const signedContent = Buffer.from(`${encodedHeader}.${encodedPayload}`);
    const signature = Buffer.from(encodedSignature, "base64url");
    if (!verifyRsaSignature("sha256", signedContent, publicKey, signature)) return null;

    if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    if (claims.iss !== this.issuerUrl) return null;
    if (claims.aud !== this.appClientId) return null;
    if (claims.token_use !== "id") return null; // access tokens carry no email and aren't sessions here
    if (typeof claims.email !== "string" || claims.email === "") return null;
    if (claims.email_verified !== true) return null;

    return claims;
  }

  /** Returns the cached public key for the key id, refetching the JWKS once for an unknown id
   * (Cognito rotates signing keys); null if the id is still unknown after a refetch. */
  private async resolvePublicKey(keyId: string): Promise<KeyObject | null> {
    if (!this.cachedPublicKeysByKeyId?.has(keyId)) {
      const jwks = await this.fetchJsonWebKeySet(`${this.issuerUrl}/.well-known/jwks.json`);
      this.cachedPublicKeysByKeyId = new Map(
        jwks.keys.map((jsonWebKey) => [jsonWebKey.kid, createPublicKey({ key: jsonWebKey, format: "jwk" })]),
      );
    }
    return this.cachedPublicKeysByKeyId.get(keyId) ?? null;
  }
}
