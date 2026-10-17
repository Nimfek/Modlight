import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The two places a scope is CHOSEN rather than checked: creating a token and
 * narrowing one.
 *
 * Both are Server Actions, which are public endpoints - the picker in the dialog
 * is a suggestion, and anything at all can post any string at them. So the rules
 * are asserted against the action, not against the component that calls it.
 */

const createApiToken = vi.fn();
const narrowApiTokenScope = vi.fn();
const requireUser = vi.fn();
const recordAudit = vi.fn();

vi.mock("@/lib/api-token", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-token")>("@/lib/api-token");
  return { ...actual, createApiToken, narrowApiTokenScope };
});
vi.mock("@/lib/auth-helpers", () => ({ requireUser }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { createUploadToken, narrowTokenScope } = await import("@/app/actions/tokens");

beforeEach(() => {
  createApiToken.mockReset().mockResolvedValue("plaintext-token");
  narrowApiTokenScope.mockReset();
  recordAudit.mockReset();
  requireUser.mockReset().mockResolvedValue({ user: { id: "u1" } });
});

describe("creating a token", () => {
  it("passes the chosen scope through", async () => {
    await expect(createUploadToken("laptop", "write")).resolves.toEqual({
      token: "plaintext-token",
      scope: "write",
    });
    expect(createApiToken).toHaveBeenCalledWith("u1", "laptop", "write");
  });

  it("falls to the NARROWEST scope when none was given", async () => {
    // A form field can always arrive empty, and the one-click ShareX button
    // never asks. Whichever value an omission lands on is the value most tokens
    // on this deployment will end up with, so it has to be the safe end.
    const result = await createUploadToken("ShareX");
    expect(result.scope).toBe("upload");
    expect(createApiToken).toHaveBeenCalledWith("u1", "ShareX", "upload");
  });

  it("refuses to widen an unrecognised value into something permissive", async () => {
    for (const junk of ["full-access", "FULL", "admin", "", "  "]) {
      createApiToken.mockClear();
      const result = await createUploadToken("x", junk);
      expect(result.scope).toBe("upload");
      expect(createApiToken).toHaveBeenCalledWith("u1", "x", "upload");
    }
  });
});

describe("narrowing a token", () => {
  it("hands the request to the store and reports what it settled on", async () => {
    narrowApiTokenScope.mockResolvedValue({ ok: true, scope: "read" });
    await expect(narrowTokenScope("tok-1", "read")).resolves.toEqual({ ok: true, scope: "read" });
    expect(narrowApiTokenScope).toHaveBeenCalledWith("tok-1", "u1", "read");
  });

  it("logs the change, because a credential's reach moved", async () => {
    narrowApiTokenScope.mockResolvedValue({ ok: true, scope: "upload" });
    await narrowTokenScope("tok-1", "upload");
    expect(recordAudit).toHaveBeenCalledWith("u1", "api_token.narrowed", {
      token: "tok-1",
      scope: "upload",
    });
  });

  it("never reaches the store with a scope it does not recognise", async () => {
    await expect(narrowTokenScope("tok-1", "superuser")).resolves.toEqual({
      ok: false,
      reason: "not-narrower",
    });
    expect(narrowApiTokenScope).not.toHaveBeenCalled();
  });

  it("surfaces the store's refusal rather than reporting success", async () => {
    // The widening check lives in the store (inside the WHERE clause, so two
    // concurrent narrowings cannot interleave into one). What this asserts is
    // that the action does not paper over a "no".
    narrowApiTokenScope.mockResolvedValue({ ok: false, reason: "not-narrower" });
    await expect(narrowTokenScope("tok-1", "full")).resolves.toEqual({
      ok: false,
      reason: "not-narrower",
    });
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
