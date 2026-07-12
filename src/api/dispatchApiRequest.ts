import type { ApiHandlerEvent, ApiHandlerResult } from "./types";
import { routes, type RouteDefinition } from "./routes";

export interface MatchedRoute {
  route: RouteDefinition;
  pathParameters: Record<string, string>;
}

export function matchRoute(method: string, pathname: string): MatchedRoute | null {
  for (const route of routes) {
    if (route.method !== method) continue;

    const paramNames: string[] = [];
    const patternSource = route.path.replace(/:([^/]+)/g, (_segment, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    const match = new RegExp(`^${patternSource}$`).exec(pathname);
    if (!match) continue;

    const pathParameters: Record<string, string> = {};
    paramNames.forEach((name, index) => {
      pathParameters[name] = match[index + 1] ?? "";
    });
    return { route, pathParameters };
  }
  return null;
}

/** The request fields every transport (local dev server, API Gateway Lambda) can supply;
 * pathParameters are filled in here from the matched route. */
export type ApiRequest = Omit<ApiHandlerEvent, "pathParameters">;

/** Matches the request against the route table and invokes the handler, translating
 * "no route" and "handler threw" into the 404/500 responses every transport shares. */
export async function dispatchApiRequest(request: ApiRequest): Promise<ApiHandlerResult> {
  const matched = matchRoute(request.httpMethod, request.path);
  if (!matched) {
    return { statusCode: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Not found" }) };
  }

  const event: ApiHandlerEvent = { ...request, pathParameters: matched.pathParameters };
  try {
    return await matched.route.handler(event);
  } catch (error) {
    console.error(error);
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Internal server error" }) };
  }
}
