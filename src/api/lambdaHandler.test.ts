import { describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";

// Importing the route table constructs the auth provider at module scope; the stub provider
// needs no env secrets, keeping this test independent of .env.
vi.hoisted(() => {
  process.env.AUTH_PROVIDER = "stub";
});

import { handler, stripApiPathPrefix } from "./lambdaHandler";
import { dispatchApiRequest, matchRoute } from "./dispatchApiRequest";

function buildApiGatewayEvent(httpMethod: string, path: string): APIGatewayProxyEvent {
  return {
    httpMethod,
    path,
    pathParameters: null,
    queryStringParameters: null,
    headers: {},
    body: null,
  } as unknown as APIGatewayProxyEvent;
}

async function invokeHandler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const result = await handler(event, {} as Context, () => undefined);
  if (!result) throw new Error("handler returned no result");
  return result;
}

describe("stripApiPathPrefix", () => {
  it("removes the /api prefix CloudFront forwards", () => {
    expect(stripApiPathPrefix("/api/gameweeks/current")).toBe("/gameweeks/current");
  });

  it("maps a bare /api to the root path", () => {
    expect(stripApiPathPrefix("/api")).toBe("/");
  });

  it("leaves unprefixed paths unchanged", () => {
    expect(stripApiPathPrefix("/gameweeks/current")).toBe("/gameweeks/current");
  });

  it("does not treat /api as a prefix of a longer first segment", () => {
    expect(stripApiPathPrefix("/apiary")).toBe("/apiary");
  });
});

describe("matchRoute", () => {
  it("extracts named path parameters from the matched route", () => {
    const matched = matchRoute("GET", "/teams/team-42/transfers/available");

    expect(matched).not.toBeNull();
    expect(matched?.pathParameters).toEqual({ teamId: "team-42" });
  });

  it("returns null when method matches no route", () => {
    expect(matchRoute("DELETE", "/gameweeks/current")).toBeNull();
  });
});

describe("dispatchApiRequest", () => {
  it("returns a JSON 404 for an unknown path", async () => {
    const result = await dispatchApiRequest({
      httpMethod: "GET",
      path: "/nonexistent",
      queryStringParameters: null,
      headers: {},
      body: null,
    });

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ message: "Not found" });
  });
});

describe("lambda handler", () => {
  it("strips the /api prefix before dispatching, so an unknown /api path 404s through the route table", async () => {
    const result = await invokeHandler(buildApiGatewayEvent("GET", "/api/nonexistent"));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ message: "Not found" });
  });
});
