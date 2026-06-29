import { createAuthProviderFromEnv } from "./createAuthProviderFromEnv";

/** Singleton, same pattern as db/client.ts — every handler uses this rather than constructing its own provider. */
export const authProvider = createAuthProviderFromEnv();
