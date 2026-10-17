import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `narrowApiTokenScope`: the function that must never widen.
 *
 * This is the anti-escalation rule, and it is the one that has to hold in the
 * store rather than only in the UI. A widening performed in place needs no new
 * secret: whoever holds a leaked read-only token would post `full` at the Server
 * Action and walk away able to delete the library the token was only ever meant
 * to show. The picker offering nothing wider is a courtesy; this is the control.
 *
 * The database is stubbed down to the two statements the function issues, and
 * the stub records what the UPDATE was asked to write - so "it refused" is
 * distinguishable from "it wrote the wrong thing and returned a refusal".
 */

const state: {
  row: { scope: unknown; revokedAt: Date | null } | undefined;
  updated: Record<string, unknown> | null;
  updateMatched: boolean;
} = { row: undefined, updated: null, updateMatched: true };

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(state.row ? [state.row] : []) }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.updated = values;
        return {
          where: () => ({
            returning: () =>
              Promise.resolve(state.updateMatched ? [{ scope: values.scope }] : []),
          }),
        };
      },
    }),
  },
}));

const { narrowApiTokenScope } = await import("@/lib/api-token");

beforeEach(() => {
  state.row = undefined;
  state.updated = null;
  state.updateMatched = true;
});

function stored(scope: unknown, revokedAt: Date | null = null) {
  state.row = { scope, revokedAt };
}

describe("narrowApiTokenScope", () => {
  it("narrows a full token to write", async () => {
    stored("full");
    await expect(narrowApiTokenScope("t1", "u1", "write")).resolves.toEqual({
      ok: true,
      scope: "write",
    });
    expect(state.updated).toEqual({ scope: "write" });
  });

  it("refuses every widening, and writes nothing", async () => {
    for (const [from, to] of [
      ["read", "write"],
      ["read", "full"],
      ["upload", "write"],
      ["upload", "full"],
      ["write", "full"],
    ] as const) {
      stored(from);
      state.updated = null;
      await expect(narrowApiTokenScope("t1", "u1", to)).resolves.toEqual({
        ok: false,
        reason: "not-narrower",
      });
      // The refusal is not enough on its own: a version that returned the
      // refusal AFTER issuing the UPDATE would pass a status-only assertion.
      expect(state.updated).toBeNull();
    }
  });

  it("refuses a sideways move between two incomparable scopes", async () => {
    // `upload` and `read` neither contains the other, so either direction hands
    // over something the token did not have.
    stored("upload");
    await expect(narrowApiTokenScope("t1", "u1", "read")).resolves.toMatchObject({ ok: false });
    stored("read");
    await expect(narrowApiTokenScope("t1", "u1", "upload")).resolves.toMatchObject({ ok: false });
    expect(state.updated).toBeNull();
  });

  it("refuses a no-op", async () => {
    stored("write");
    await expect(narrowApiTokenScope("t1", "u1", "write")).resolves.toMatchObject({ ok: false });
  });

  it("refuses a token that is not the caller's, or does not exist", async () => {
    // Ownership lives in the SELECT's WHERE, so "somebody else's" and "gone"
    // reach here as the same absent row and get the same answer.
    state.row = undefined;
    await expect(narrowApiTokenScope("t1", "u1", "read")).resolves.toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("refuses a revoked token instead of quietly editing a dead row", async () => {
    stored("full", new Date());
    await expect(narrowApiTokenScope("t1", "u1", "read")).resolves.toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(state.updated).toBeNull();
  });

  it("refuses a stored scope this build cannot compare", async () => {
    // An unrecognised value has no capability set, so there is nothing to be a
    // subset of. Refusing is the only answer that is not a guess.
    stored("superuser");
    await expect(narrowApiTokenScope("t1", "u1", "read")).resolves.toEqual({
      ok: false,
      reason: "not-narrower",
    });
    expect(state.updated).toBeNull();
  });

  it("reports a lost race rather than claiming success", async () => {
    // The UPDATE pins the scope it read (`scope = current`), so a concurrent
    // narrowing that landed first leaves this one matching nothing.
    stored("full");
    state.updateMatched = false;
    await expect(narrowApiTokenScope("t1", "u1", "read")).resolves.toEqual({
      ok: false,
      reason: "not-narrower",
    });
  });
});
