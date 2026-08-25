import { describe, expect, it } from "vitest";
import { MalformedJsonRequestBodyError, parseJsonRequestBody } from "./parseJsonRequestBody";

describe("parseJsonRequestBody", () => {
  it("parses a JSON object body", () => {
    expect(parseJsonRequestBody<{ email: string }>('{"email":"a@b.com"}')).toEqual({ email: "a@b.com" });
  });

  it("treats an absent body as an empty object, leaving required-field errors to the handler", () => {
    expect(parseJsonRequestBody(null)).toEqual({});
    expect(parseJsonRequestBody("")).toEqual({});
    expect(parseJsonRequestBody("   ")).toEqual({});
  });

  it("rejects unparseable JSON", () => {
    expect(() => parseJsonRequestBody("{not json")).toThrow(MalformedJsonRequestBodyError);
  });

  it("rejects JSON that parses to something a handler cannot read fields off", () => {
    for (const body of ["null", "5", '"text"', "[]"]) {
      expect(() => parseJsonRequestBody(body)).toThrow(MalformedJsonRequestBodyError);
    }
  });
});
