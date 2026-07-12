import { createServer } from "node:http";
import type { ApiHandlerEvent } from "./types";
import { dispatchApiRequest } from "./dispatchApiRequest";

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

      const queryStringParameters: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        queryStringParameters[key] = value;
      });

      const result = await dispatchApiRequest({
        httpMethod: req.method ?? "GET",
        path: url.pathname,
        queryStringParameters,
        headers: req.headers as ApiHandlerEvent["headers"],
        body: chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : null,
      });

      res.writeHead(result.statusCode, { "content-type": "application/json", ...CORS_HEADERS, ...result.headers });
      res.end(result.body);
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Local API server listening on port ${port}`);
  });
}
