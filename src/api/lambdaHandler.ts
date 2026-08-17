import type { APIGatewayProxyHandler } from "aws-lambda";
import { loadRuntimeConfigFromSsm } from "../runtimeConfig/loadRuntimeConfigFromSsm";
import { forbiddenResponse } from "./httpResponse";
import { requestCarriesValidCloudFrontOriginSecret } from "./verifyCloudFrontOriginSecret";

/** CloudFront routes the site's /api/* behavior to the HTTP API without rewriting the path,
 * while the route table (src/api/routes.ts) registers paths without the prefix. */
export function stripApiPathPrefix(path: string): string {
  if (path === "/api") return "/";
  if (path.startsWith("/api/")) return path.slice("/api".length);
  return path;
}

/** The db pool and auth provider read env vars at import time, so the route table can only be
 * imported after the SSM secrets have been loaded into process.env — hence the dynamic import.
 * Both happen once per cold start; warm invocations just await the already-resolved promise.
 *
 * This is why the static imports above must stay dependency-free (httpResponse pulls in only a
 * type; verifyCloudFrontOriginSecret only node:crypto). Do not let either reach the route table. */
const initializedApi = (async () => {
  await loadRuntimeConfigFromSsm();
  const { dispatchApiRequest } = await import("./dispatchApiRequest");
  return { dispatchApiRequest };
})();

/** Entrypoint for the deployed API: API Gateway HTTP API (payload format 1.0) proxies every
 * request here and this dispatches to the same handler functions the local dev server uses. */
export const handler: APIGatewayProxyHandler = async (event) => {
  const { dispatchApiRequest } = await initializedApi;

  // 403 rather than requireAuth's 401, so "you bypassed the CDN" stays distinguishable from
  // "you are not signed in" — the deployment smoke test asserts on exactly that difference.
  if (
    !requestCarriesValidCloudFrontOriginSecret(
      event.headers,
      process.env.CLOUDFRONT_ORIGIN_VERIFY_SECRET,
    )
  ) {
    return forbiddenResponse("This API must be reached through the site, not directly");
  }

  const body =
    event.body !== null && event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;

  return dispatchApiRequest({
    httpMethod: event.httpMethod,
    path: stripApiPathPrefix(event.path),
    queryStringParameters: event.queryStringParameters ?? {},
    headers: event.headers,
    body,
  });
};
