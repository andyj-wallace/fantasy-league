import { describe, expect, it } from "vitest";
import {
  CLOUDFRONT_ORIGIN_VERIFY_HEADER_NAME,
  requestCarriesValidCloudFrontOriginSecret,
} from "./verifyCloudFrontOriginSecret";

const EXPECTED_SECRET = "a".repeat(64);

describe("requestCarriesValidCloudFrontOriginSecret", () => {
  it("allows every request when no secret is configured, so local dev and tests are unaffected", () => {
    expect(requestCarriesValidCloudFrontOriginSecret({}, undefined)).toBe(true);
    expect(requestCarriesValidCloudFrontOriginSecret({}, "")).toBe(true);
  });

  it("allows a request carrying the matching secret", () => {
    const headers = { [CLOUDFRONT_ORIGIN_VERIFY_HEADER_NAME]: EXPECTED_SECRET };

    expect(requestCarriesValidCloudFrontOriginSecret(headers, EXPECTED_SECRET)).toBe(true);
  });

  it("accepts the capitalised header spelling, since only payload format 1.0 lowercases it", () => {
    const headers = { "X-Origin-Verify": EXPECTED_SECRET };

    expect(requestCarriesValidCloudFrontOriginSecret(headers, EXPECTED_SECRET)).toBe(true);
  });

  it("rejects a request with no origin header at all — the execute-api bypass case", () => {
    expect(requestCarriesValidCloudFrontOriginSecret({}, EXPECTED_SECRET)).toBe(false);
    expect(requestCarriesValidCloudFrontOriginSecret(null, EXPECTED_SECRET)).toBe(false);
    expect(requestCarriesValidCloudFrontOriginSecret(undefined, EXPECTED_SECRET)).toBe(false);
  });

  it("rejects a wrong secret of the same length", () => {
    const headers = { [CLOUDFRONT_ORIGIN_VERIFY_HEADER_NAME]: "b".repeat(64) };

    expect(requestCarriesValidCloudFrontOriginSecret(headers, EXPECTED_SECRET)).toBe(false);
  });

  it("rejects rather than throws on a length mismatch, which timingSafeEqual would not tolerate", () => {
    const headers = { [CLOUDFRONT_ORIGIN_VERIFY_HEADER_NAME]: "short" };

    expect(requestCarriesValidCloudFrontOriginSecret(headers, EXPECTED_SECRET)).toBe(false);
  });

  it("rejects an empty header value", () => {
    const headers = { [CLOUDFRONT_ORIGIN_VERIFY_HEADER_NAME]: "" };

    expect(requestCarriesValidCloudFrontOriginSecret(headers, EXPECTED_SECRET)).toBe(false);
  });
});
