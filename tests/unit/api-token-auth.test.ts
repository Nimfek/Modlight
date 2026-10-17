import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `authenticateApiToken`: the one function every token surface goes through.
 *
 * The cases that matter are the ones where an honest-looking implementation is
 * wrong: a scope value this build does not recognise must be a REFUSAL and not a
 * shrug, a banned account must be told it is banned rather than told to go and
 * mint a wider token, and `last_used_at` must be stamped even when the answer is
 * no - a token being turned away over and over is exactly the thing somebody
 * debugging a client needs to be able to see.
 *
 * The database is stubbed down to the two statements this function issues, and
 * the stub records them, so "did the UPDATE actually run" is an assertion rather
 * than an assumption. (That is not paranoia: an earlier version of this function
 * built the UPDATE and threw it away, because a Drizzle builder is a lazy
 * thenable, and every `last_used_at` in production stayed NULL for months.)
 */

type TokenRow = { userId: string; scope: unknown } | undefined;
type UserRow = Record<string, unknown> | undefined;

const state: { token: TokenRow; user: UserRow; updates: number; selects: number } = {
  token: undefined,
  user: undefined,
  updates: 0,
  selects: 0,
};

vi.mock("@/lib/db", () => {
  const update = () => ({
    set: () => ({
      where: () => ({
        returning: () => {
          state.updates++;
          return Promise.resolve(state.token ? [state.token] : []);
        },
      }),
    }),
  });
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: () => {
          state.selects++;
          return Promise.resolve(state.user ? [state.user] : []);
        },
      }),
    }),
  });
  return { db: { update, select } };
});

const { authenticateApiToken, tokenRefusal, scopeRefusalBody } = await import("@/lib/api-token");

const ME = { id: "u1", banned: false, role: "user" };

beforeEach(() => {
  state.token = undefined;
  state.user = undefined;
  state.updates = 0;
  state.selects = 0;
});

function have(scope: unknown, user: Record<string, unknown> = ME) {
  state.token = { userId: "u1", scope };
  state.user = user;
}

describe("authenticateApiToken", () => {
  it("resolves a token whose scope covers the call", async () => {
    have("write");
    await expect(authenticateApiToken("tok", "write")).resolves.toEqual({
      ok: true,
      user: ME,
      scope: "write",
    });
  });

  it("refuses a token whose scope does not, and says which scope would", async () => {
    have("read");
    const auth = await authenticateApiToken("tok", "write");
    expect(auth).toMatchObject({ ok: false, reason: "scope", scope: "read", required: "write" });
    expect(auth.ok === false && auth.reason === "scope" && scopeRefusalBody(auth)).toMatchObject({
      reason: "insufficient_scope",
      scope: "read",
      required_scope: "write",
    });
  });

  it("still stamps last_used_at when it then refuses on scope", async () => {
    have("upload");
    await authenticateApiToken("tok", "read");
    expect(state.updates).toBe(1);
  });

  it("fails CLOSED on a scope value this build does not recognise", async () => {
    // The only ways such a row exists are a rollback to an older build or a
    // hand-edited database. Treating an unknown value as permissive would guess
    // in the attacker's favour; treating it as "no capability at all" is the
    // only guess that cannot be exploited.
    for (const stored of ["superuser", "", "FULL", null, undefined, 7]) {
      have(stored);
      await expect(authenticateApiToken("tok", "identify")).resolves.toEqual({
        ok: false,
        reason: "invalid-scope",
      });
    }
  });

  it("refuses a banned account before it ever looks at the scope", async () => {
    // Otherwise a disabled account with a narrow token is told to go and create
    // a wider one, which would not work either.
    have("upload", { id: "u1", banned: true, role: "user" });
    await expect(authenticateApiToken("tok", "write")).resolves.toMatchObject({
      ok: false,
      reason: "banned",
    });
  });

  it("refuses an unknown or revoked token without reading a user row", async () => {
    state.token = undefined;
    await expect(authenticateApiToken("tok", "identify")).resolves.toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(state.selects).toBe(0);
  });

  it("refuses a token whose account has since been deleted", async () => {
    state.token = { userId: "gone", scope: "full" };
    state.user = undefined;
    await expect(authenticateApiToken("tok", "read")).resolves.toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("asks the database nothing when no token was offered", async () => {
    await expect(authenticateApiToken(null, "read")).resolves.toEqual({
      ok: false,
      reason: "unknown",
    });
    await expect(authenticateApiToken("", "read")).resolves.toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(state.updates).toBe(0);
  });
});

describe("how a refusal reaches the wire", () => {
  it("answers a scope refusal with 403, not a bare 401", async () => {
    have("read");
    const auth = await authenticateApiToken("tok", "write");
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    const { status, body } = tokenRefusal(auth, "Token specified not found.");
    expect(status).toBe(403);
    // The sentence has to name the scope to create. A 401 with nothing in it is
    // what sends somebody regenerating a config that was never the problem.
    expect(String(body.message)).toContain('"write"');
    expect(body.reason).toBe("insufficient_scope");
  });

  it("answers an unrecognised scope with 403 too, because the token is real", async () => {
    have("superuser");
    const auth = await authenticateApiToken("tok", "read");
    if (auth.ok) throw new Error("expected a refusal");
    expect(tokenRefusal(auth, "x")).toMatchObject({ status: 403, body: { reason: "invalid_scope" } });
  });

  it("keeps each surface's own wording for an unknown token", async () => {
    // ShareX has answered with this exact string since v1 and third-party
    // scripts match on it; the JSON API has its own. Only this one line differs.
    state.token = undefined;
    const auth = await authenticateApiToken("tok", "read");
    if (auth.ok) throw new Error("expected a refusal");
    expect(tokenRefusal(auth, "Token specified not found.")).toEqual({
      status: 401,
      body: { message: "Token specified not found." },
    });
    expect(tokenRefusal(auth, "Token not specified or not found.").body).toEqual({
      message: "Token not specified or not found.",
    });
  });

  it("answers a banned account with 401", async () => {
    have("full", { id: "u1", banned: true, role: "user" });
    const auth = await authenticateApiToken("tok", "read");
    if (auth.ok) throw new Error("expected a refusal");
    expect(tokenRefusal(auth, "x")).toEqual({ status: 401, body: { message: "Account disabled." } });
  });
});
