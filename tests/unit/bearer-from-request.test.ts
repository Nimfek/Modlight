import { describe, it, expect } from "vitest";
import { bearerFromRequest } from "@/lib/api-token";

/**
 * Header parsing for the token-authenticated API surface.
 *
 * The case worth pinning is the empty `x-api-key`. The first version read
 * `get("x-api-key") ?? <bearer>`, which looks equivalent and is not: `??` falls
 * through on null only, and an absent header returns null while a PRESENT but
 * empty one returns "". Any client whose config field is left blank sends the
 * latter, which killed the Authorization branch and answered 401 to a caller
 * holding a valid token.
 */

const h = (init: Record<string, string>) => new Headers(init);

describe("bearerFromRequest", () => {
  it("takes x-api-key when it carries a value", () => {
    expect(bearerFromRequest(h({ "x-api-key": "tok_abc" }))).toBe("tok_abc");
  });

  it("falls through to Authorization when x-api-key is present but EMPTY", () => {
    expect(bearerFromRequest(h({ "x-api-key": "", authorization: "Bearer tok_xyz" }))).toBe(
      "tok_xyz",
    );
  });

  it("falls through when x-api-key is only whitespace", () => {
    expect(bearerFromRequest(h({ "x-api-key": "   ", authorization: "Bearer tok_xyz" }))).toBe(
      "tok_xyz",
    );
  });

  it("accepts any capitalisation of the Bearer scheme", () => {
    expect(bearerFromRequest(h({ authorization: "bearer tok_1" }))).toBe("tok_1");
    expect(bearerFromRequest(h({ authorization: "BEARER tok_2" }))).toBe("tok_2");
  });

  it("trims surrounding whitespace off the token", () => {
    expect(bearerFromRequest(h({ "x-api-key": "  tok_pad  " }))).toBe("tok_pad");
    expect(bearerFromRequest(h({ authorization: "Bearer   tok_pad  " }))).toBe("tok_pad");
  });

  it("returns null when there is nothing usable", () => {
    expect(bearerFromRequest(h({}))).toBeNull();
    expect(bearerFromRequest(h({ "x-api-key": "" }))).toBeNull();
    expect(bearerFromRequest(h({ authorization: "Bearer" }))).toBeNull();
    expect(bearerFromRequest(h({ authorization: "Bearer    " }))).toBeNull();
    // Not our scheme: must not be mistaken for a token.
    expect(bearerFromRequest(h({ authorization: "Basic dXNlcjpwYXNz" }))).toBeNull();
  });
});
