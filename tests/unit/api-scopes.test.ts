import { describe, it, expect } from "vitest";
import {
  TOKEN_SCOPES,
  SCOPE_FOR,
  LEGACY_TOKEN_SCOPE,
  capabilitiesOf,
  isNarrowing,
  isTokenScope,
  narrowerScopes,
  scopeGrants,
  type TokenCapability,
  type TokenScope,
} from "@/lib/api-scopes";

/**
 * The scope lattice, on its own, with no database and no HTTP.
 *
 * Everything that enforces a scope reduces to `scopeGrants`, and every refusal
 * to change one reduces to `isNarrowing`. If either is wrong, every surface is
 * wrong in the same direction at once - which is why they are pinned here rather
 * than only through the routes that call them.
 */

describe("what each scope grants", () => {
  it("gives upload-only tokens exactly one power beyond identifying themselves", () => {
    expect(capabilitiesOf("upload")).toEqual(["identify", "upload"]);
    expect(scopeGrants("upload", "upload")).toBe(true);
    // The whole point of the narrowest scope: a leaked .sxcu cannot read, change
    // or delete the library it has been feeding.
    expect(scopeGrants("upload", "read")).toBe(false);
    expect(scopeGrants("upload", "write")).toBe(false);
    expect(scopeGrants("upload", "admin")).toBe(false);
  });

  it("lets a read token see and nothing else", () => {
    expect(scopeGrants("read", "read")).toBe(true);
    expect(scopeGrants("read", "upload")).toBe(false);
    expect(scopeGrants("read", "write")).toBe(false);
  });

  it("gives a write token everything except administrator endpoints", () => {
    expect(scopeGrants("write", "upload")).toBe(true);
    expect(scopeGrants("write", "read")).toBe(true);
    expect(scopeGrants("write", "write")).toBe(true);
    // An administrator holding a `write` token still cannot publish a release
    // with it: role and scope are two different questions.
    expect(scopeGrants("write", "admin")).toBe(false);
  });

  it("gives full everything", () => {
    for (const cap of ["identify", "upload", "read", "write", "admin"] as TokenCapability[]) {
      expect(scopeGrants("full", cap)).toBe(true);
    }
  });

  it("lets every scope identify itself, so no token is locked out of /api/me", () => {
    // A client that cannot ask "does this credential work" has to find out by
    // uploading something, which is the one thing an upload-only token should
    // not have to do just to verify a config.
    for (const scope of TOKEN_SCOPES) expect(scopeGrants(scope, "identify")).toBe(true);
  });

  it("names, for every capability, the narrowest scope that grants it", () => {
    for (const [cap, scope] of Object.entries(SCOPE_FOR) as [TokenCapability, TokenScope][]) {
      expect(scopeGrants(scope, cap)).toBe(true);
      // Nothing narrower may also grant it, or the 403 would be sending people
      // to a wider token than they need.
      for (const other of narrowerScopes(scope)) expect(scopeGrants(other, cap)).toBe(false);
    }
  });
});

describe("narrowing, never widening", () => {
  it("allows only a proper subset of what the token already had", () => {
    expect(isNarrowing("full", "write")).toBe(true);
    expect(isNarrowing("full", "read")).toBe(true);
    expect(isNarrowing("full", "upload")).toBe(true);
    expect(isNarrowing("write", "read")).toBe(true);
    expect(isNarrowing("write", "upload")).toBe(true);
  });

  it("refuses every widening", () => {
    // The escalation this exists to stop: whoever holds a leaked read-only token
    // must not be able to promote it into one that can empty the library.
    expect(isNarrowing("read", "write")).toBe(false);
    expect(isNarrowing("read", "full")).toBe(false);
    expect(isNarrowing("upload", "write")).toBe(false);
    expect(isNarrowing("write", "full")).toBe(false);
  });

  it("refuses a no-op, so 'the scope changed' is always true when it succeeds", () => {
    for (const scope of TOKEN_SCOPES) expect(isNarrowing(scope, scope)).toBe(false);
  });

  it("treats upload and read as incomparable, in both directions", () => {
    // Neither contains the other. A rank-based comparison would have had to put
    // one of them first, and whichever it was, "narrowing" would have quietly
    // handed over the other one's power.
    expect(isNarrowing("upload", "read")).toBe(false);
    expect(isNarrowing("read", "upload")).toBe(false);
  });

  it("offers only legal choices to the UI", () => {
    expect(narrowerScopes("full").sort()).toEqual(["read", "upload", "write"]);
    expect(narrowerScopes("write").sort()).toEqual(["read", "upload"]);
    // Nothing is narrower than these two, so the panel shows no button at all
    // rather than a dialog with nothing in it.
    expect(narrowerScopes("upload")).toEqual([]);
    expect(narrowerScopes("read")).toEqual([]);
  });

  it("agrees with the capability sets it claims to compare", () => {
    for (const from of TOKEN_SCOPES) {
      for (const to of TOKEN_SCOPES) {
        if (!isNarrowing(from, to)) continue;
        // Whatever a narrowing produces must be a strict subset of what was
        // there, not merely a different-looking name.
        for (const cap of capabilitiesOf(to)) expect(scopeGrants(from, cap)).toBe(true);
        expect(capabilitiesOf(to).length).toBeLessThan(capabilitiesOf(from).length);
      }
    }
  });
});

describe("recognising a stored value", () => {
  it("accepts the four scopes and nothing else", () => {
    for (const scope of TOKEN_SCOPES) expect(isTokenScope(scope)).toBe(true);
    for (const junk of ["", "FULL", "admin", "readwrite", null, undefined, 3, {}]) {
      expect(isTokenScope(junk)).toBe(false);
    }
  });

  it("backfills legacy rows to full", () => {
    // Not because it is convenient: those tokens already do everything, and a
    // migration that quietly took capability away would surface as bug reports
    // about the panel rather than as a decision anybody made.
    expect(LEGACY_TOKEN_SCOPE).toBe("full");
  });
});
