import { describe, expect, it } from "vitest";
import { validateDisplayName, validateEmail } from "./credentialValidation";

describe("validateEmail", () => {
  it("accepts a plausible address", () => {
    expect(validateEmail("player@example.com")).toBeNull();
  });

  it("rejects missing, empty, and non-string emails", () => {
    expect(validateEmail(undefined)).toMatch(/required/);
    expect(validateEmail("")).toMatch(/required/);
    expect(validateEmail(123)).toMatch(/required/);
  });

  it("rejects malformed addresses", () => {
    expect(validateEmail("no-at-sign")).toMatch(/valid/);
    expect(validateEmail("missing@domain")).toMatch(/valid/);
    expect(validateEmail("spaces in@email.com")).toMatch(/valid/);
  });

  it("rejects an oversized address", () => {
    expect(validateEmail("a".repeat(250) + "@example.com")).toMatch(/too long/);
  });
});

describe("validateDisplayName", () => {
  it("treats an absent display name as valid (optional)", () => {
    expect(validateDisplayName(undefined)).toBeNull();
    expect(validateDisplayName(null)).toBeNull();
  });

  it("accepts a normal name", () => {
    expect(validateDisplayName("Andy")).toBeNull();
  });

  it("rejects blank and oversized names", () => {
    expect(validateDisplayName("   ")).toMatch(/blank/);
    expect(validateDisplayName("x".repeat(61))).toMatch(/too long/);
  });

  it("rejects a non-string display name", () => {
    expect(validateDisplayName(42)).toMatch(/string/);
  });
});
