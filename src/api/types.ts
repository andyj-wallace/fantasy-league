import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

/**
 * The subset of the API Gateway Lambda proxy event our handlers read. A real APIGatewayProxyEvent
 * satisfies this structurally, so deployed handlers receive it unmodified; the local dev server
 * only has to construct this smaller shape instead of a full (mostly-unused) AWS event object.
 */
export type ApiHandlerEvent = Pick<
  APIGatewayProxyEvent,
  "httpMethod" | "path" | "pathParameters" | "queryStringParameters" | "headers" | "body"
>;

export type ApiHandlerResult = APIGatewayProxyResult;

export type ApiHandler = (event: ApiHandlerEvent) => Promise<ApiHandlerResult>;
