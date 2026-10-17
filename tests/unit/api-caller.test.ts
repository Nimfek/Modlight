import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  tokenBanned,
  tokenInvalidScope,
  tokenOk,
  tokenScoped,
  tokenUnknown,
} from "../helpers/token-auth";

/**
 * Who a token-or-session API route decides is calling.
 *
 * The case worth pinning is the one that reads as harmless: a token that is
 * PRESENT and wrong must be a refusal, never a fall-through to whatever cookie
 * the same request carried. Written the obvious way - "try the token, then try
 * the session" - a desktop client holding a revoked token keeps working wherever
 * a browser session exists and stops working where it does not, and the request
 * that "worked" was answered from a credential the caller no longer holds.
 *
 * The token store and Better Auth are both stubbed: what is under test is which
 * branch runs, not what either of them returns.
 */

const authenticateApiToken = vi.fn();
const getSession = vi.fn();

vi.mock("@/lib/api-token", async () => {
  // Everything except the lookup is the real thing - bearerFromRequest, because
  // the header rule it implements is the input to every branch below, and
  // tokenRefusal, because the status and body a refusal turns into is exactly
  // what these tests are asserting on.
  const actual = await vi.importActual<typeof import("@/lib/api-token")>("@/lib/api-token");
  return { ...actual, authenticateApiToken };
});
vi.mock("@/lib/auth-helpers", () => ({ getSession }));

const { resolveApiCaller } = await import("@/lib/api-caller");

const request = (headers: Record<string, string> = {}) =>
  new Request("https://host.example.com/api/client-settings", { headers });

beforeEach(() => {
  authenticateApiToken.mockReset();
  getSession.mockReset();
});

describe("resolveApiCaller", () => {
  it("resolves an account from a valid token without touching the session", async () => {
    authenticateApiToken.mockResolvedValue(tokenOk({ id: "u1", banned: false, role: "user" }));
    await expect(resolveApiCaller(request({ "x-api-key": "tok" }), "read")).resolves.toEqual({
      ok: true,
      caller: { id: "u1", role: "user" },
      scope: "full",
    });
    // The capability the ROUTE asked for reaches the store: a helper that
    // quietly dropped it would leave every surface unscoped while every test
    // still passed.
    expect(authenticateApiToken).toHaveBeenCalledWith("tok", "read");
  });

  it("refuses an invalid token instead of falling back to the session", async () => {
    // The session here is deliberately valid: if the fallback ran, the answer
    // would be somebody's real data returned to a caller whose credential was
    // rejected a line earlier.
    authenticateApiToken.mockResolvedValue(tokenUnknown());
    getSession.mockResolvedValue({ user: { id: "u2", role: "admin" } });

    await expect(resolveApiCaller(request({ "x-api-key": "revoked" }), "read")).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
    await expect(
      resolveApiCaller(request({ authorization: "Bearer revoked" }), "read"),
    ).resolves.toMatchObject({ ok: false, status: 401 });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("refuses a banned account holding a working token", async () => {
    // Disabling an account does not delete its tokens, so `api_tokens` alone
    // cannot answer "is this user still allowed" - the check has to be here.
    authenticateApiToken.mockResolvedValue(tokenBanned({ id: "u3", banned: true, role: "user" }));
    await expect(resolveApiCaller(request({ "x-api-key": "tok" }), "read")).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("answers a scope refusal with 403 and the scope the call needed", async () => {
    // Not a 401. A bare 401 on a token that is real and simply too narrow sends
    // somebody regenerating a config that was never the problem; the body has to
    // name what to create instead.
    authenticateApiToken.mockResolvedValue(
      tokenScoped({ id: "u6", banned: false, role: "user" }, "read", "write"),
    );
    const result = await resolveApiCaller(request({ "x-api-key": "tok" }), "write");
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(result.ok === false && result.body).toMatchObject({
      reason: "insufficient_scope",
      scope: "read",
      required_scope: "write",
    });
    expect(String(result.ok === false && result.body.message)).toContain("write");
  });

  it("refuses a token whose stored scope this build does not recognise", async () => {
    // Fail CLOSED. The only ways such a row exists are a downgrade or a
    // hand-edited database, and guessing in either case guesses in the
    // attacker's favour.
    authenticateApiToken.mockResolvedValue(tokenInvalidScope());
    await expect(resolveApiCaller(request({ "x-api-key": "tok" }), "read")).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("falls back to the session only when no token was offered", async () => {
    getSession.mockResolvedValue({ user: { id: "u4", role: "admin" } });
    await expect(resolveApiCaller(request(), "write")).resolves.toEqual({
      ok: true,
      caller: { id: "u4", role: "admin" },
      // A signed-in browser IS the account: there is no cookie to narrow, so it
      // satisfies every capability and reports no scope at all.
      scope: null,
    });
    expect(authenticateApiToken).not.toHaveBeenCalled();
  });

  it("treats a present but empty x-api-key as 'no token offered'", async () => {
    // Every HTTP client sends an empty header when its config field is blank.
    // Reading that as a rejected credential would lock a signed-in browser out
    // of the same URL for no reason.
    getSession.mockResolvedValue({ user: { id: "u5", role: null } });
    await expect(resolveApiCaller(request({ "x-api-key": "" }), "read")).resolves.toEqual({
      ok: true,
      caller: { id: "u5", role: null },
      scope: null,
    });
    expect(authenticateApiToken).not.toHaveBeenCalled();
  });

  it("refuses when there is neither a token nor a session", async () => {
    getSession.mockResolvedValue(null);
    await expect(resolveApiCaller(request(), "read")).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
  });
});
