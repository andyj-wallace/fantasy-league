import { createServer } from "node:http";
import type { ApiHandlerEvent } from "./types";
import { routes, type RouteDefinition } from "./routes";

interface MatchedRoute {
  route: RouteDefinition;
  pathParameters: Record<string, string>;
}

function matchRoute(method: string, pathname: string): MatchedRoute | null {
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

/** Browser requests come from the Next.js dev server's own origin (a different port), so every
 * response needs CORS headers and preflight OPTIONS requests need to be answered directly —
 * neither API Gateway concern applies once this is actually deployed behind the same domain, but
 * locally there's no proxy in front of this to add them. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

/** Simulates an API Gateway + Lambda proxy integration locally, against the same handler functions deployed to AWS. */
export function startLocalApiServer(port: number): void {
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void handleRequest();
    });

    async function handleRequest() {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const matched = matchRoute(req.method ?? "GET", url.pathname);

      if (!matched) {
        res.writeHead(404, { "content-type": "application/json", ...CORS_HEADERS });
        res.end(JSON.stringify({ message: "Not found" }));
        return;
      }

      const queryStringParameters: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        queryStringParameters[key] = value;
      });

      const event: ApiHandlerEvent = {
        httpMethod: req.method ?? "GET",
        path: url.pathname,
        pathParameters: matched.pathParameters,
        queryStringParameters,
        headers: req.headers as ApiHandlerEvent["headers"],
        body: chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null,
      };

      let result;
      try {
        result = await matched.route.handler(event);
      } catch (error) {
        console.error(error);
        res.writeHead(500, { "content-type": "application/json", ...CORS_HEADERS });
        res.end(JSON.stringify({ message: "Internal server error" }));
        return;
      }

      res.writeHead(result.statusCode, { "content-type": "application/json", ...CORS_HEADERS, ...result.headers });
      res.end(result.body);
    }
  });

  server.listen(port, () => {
    console.log(`Local API server listening on port ${port}`);
  });
}
