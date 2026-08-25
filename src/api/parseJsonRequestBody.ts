import type { ApiHandlerEvent } from "./types";

/**
 * Thrown when a request body is present but isn't a JSON object. dispatchApiRequest translates it
 * into a 400, so a client sending malformed JSON gets "your request was bad" rather than the 500
 * (and logged server error) an uncaught SyntaxError from JSON.parse would produce.
 */
export class MalformedJsonRequestBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedJsonRequestBodyError";
  }
}

/**
 * Parses a request body into the handler's expected shape. An absent or empty body yields an empty
 * object, so handlers keep validating missing fields themselves ("name is required") instead of
 * having to distinguish "no body" from "body without that field".
 *
 * Non-object JSON (`null`, `5`, `"text"`, `[]`) is rejected here rather than handed to a handler
 * that would immediately dereference a field on it.
 */
export function parseJsonRequestBody<TRequestBody>(rawBody: ApiHandlerEvent["body"]): TRequestBody {
  if (rawBody === null || rawBody === undefined || rawBody.trim() === "") return {} as TRequestBody;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    throw new MalformedJsonRequestBodyError("Request body is not valid JSON");
  }

  if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
    throw new MalformedJsonRequestBodyError("Request body must be a JSON object");
  }
  return parsedBody as TRequestBody;
}
