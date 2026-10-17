import { describe, it, expect } from "vitest";
import {
  CLIENT_SETTINGS_BODY_MAX_BYTES,
  CLIENT_SETTINGS_MAX_BYTES,
  DESKTOP_CLIENT,
  MAX_EXPECTED_VERSION,
  bodyTooLargeMessage,
  normalizeClient,
  parseClientSettingsBody,
} from "@/lib/client-settings";

/**
 * The gate in front of a user-writable jsonb column.
 *
 * Everything pinned here is a property the desktop client depends on and the
 * database cannot defend for itself: the payload is opaque, the writer is an
 * unattended background process on somebody else's machine, and the endpoint is
 * reachable with nothing but an API token.
 */

const envelope = (settings: unknown, version?: unknown) =>
  JSON.stringify(version === undefined ? { settings } : { settings, version });

describe("client kind", () => {
  it("defaults to desktop when the caller says nothing", () => {
    // The only client that exists should not have to name itself; the parameter
    // is there for the one after it.
    expect(normalizeClient(null)).toBe(DESKTOP_CLIENT);
    expect(normalizeClient(undefined)).toBe(DESKTOP_CLIENT);
    expect(normalizeClient("")).toBe(DESKTOP_CLIENT);
  });

  it("refuses a kind that is not on the allowlist", () => {
    // This is the row-count guard, not tidiness. A discriminator taken straight
    // from the query string lets one account own unlimited rows, and the byte
    // cap on each one stops bounding anything.
    expect(normalizeClient("mobile")).toBeNull();
    expect(normalizeClient("desktop2")).toBeNull();
    expect(normalizeClient("../../etc/passwd")).toBeNull();
    expect(normalizeClient("x".repeat(500))).toBeNull();
  });

  it("accepts the known kind however it is capitalised or padded", () => {
    expect(normalizeClient(" Desktop ")).toBe(DESKTOP_CLIENT);
    expect(normalizeClient("DESKTOP")).toBe(DESKTOP_CLIENT);
  });
});

describe("PUT body", () => {
  it("accepts an envelope and reports the canonical size", () => {
    const result = parseClientSettingsBody(envelope({ hotkeys: { capture: "PrintScreen" } }));
    expect(result).toMatchObject({ ok: true, expectedVersion: null });
    if (!result.ok) throw new Error("unreachable");
    expect(result.settings).toEqual({ hotkeys: { capture: "PrintScreen" } });
    expect(result.bytes).toBe(JSON.stringify({ hotkeys: { capture: "PrintScreen" } }).length);
  });

  it("keeps 'no expected version' distinct from 'expected version 0'", () => {
    // The two mean different things at the database: absent is a blind replace,
    // 0 asserts that nothing is stored yet. Collapsing them would turn a fresh
    // machine's first sync into an overwrite of whatever was already there.
    const blind = parseClientSettingsBody(envelope({}));
    const fresh = parseClientSettingsBody(envelope({}, 0));
    expect(blind.ok && blind.expectedVersion).toBeNull();
    expect(fresh.ok && fresh.expectedVersion).toBe(0);
  });

  it("refuses a version that is not a non-negative integer", () => {
    // A float, a negative or a string could only ever match nothing, so failing
    // loudly beats a silent 409 the client cannot act on.
    for (const bad of [-1, 1.5, "3", true, [], {}]) {
      const result = parseClientSettingsBody(envelope({}, bad));
      expect(result.ok, `version ${JSON.stringify(bad)}`).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
    }
  });

  it("refuses a version too large for the int4 column", () => {
    // Not pedantry: an expected version travels to Postgres as a parameter typed
    // by that column, so an out-of-range value is a raised driver error - a 500
    // for a body that deserved a 400. The ceiling is one below int4's because a
    // successful write stores `expected + 1`.
    expect(parseClientSettingsBody(envelope({}, MAX_EXPECTED_VERSION)).ok).toBe(true);
    for (const bad of [MAX_EXPECTED_VERSION + 1, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      const result = parseClientSettingsBody(envelope({}, bad));
      expect(result.ok, `version ${bad}`).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
    }
  });

  it("reads an explicit null version as 'no check'", () => {
    // JSON has no other spelling for an unset number: a client whose field is
    // empty serialises null, and NaN comes out as null too. Treating that as a
    // malformed request would fail saves for a value the client never chose.
    const result = parseClientSettingsBody(envelope({}, null));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.expectedVersion).toBeNull();
  });

  it("refuses a payload that is not a JSON object", () => {
    // An array or a scalar would be stored happily by jsonb and come back out of
    // a GET as something the client's parser was never written for.
    for (const bad of ["[]", '"a string"', "42", "null", "true"]) {
      expect(parseClientSettingsBody(`{"settings": ${bad}}`).ok).toBe(false);
    }
    expect(parseClientSettingsBody("[]").ok).toBe(false);
    expect(parseClientSettingsBody("null").ok).toBe(false);
  });

  it("requires the envelope rather than guessing", () => {
    // A bare object could be the settings, or an envelope whose `settings` key
    // is missing. Guessing gets called wrong on somebody's real configuration.
    const result = parseClientSettingsBody(JSON.stringify({ hotkeys: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("answers 400, not 500, for a body that is not JSON at all", () => {
    for (const bad of ["", "   ", "{", "not json", "{'single': 'quotes'}"]) {
      const result = parseClientSettingsBody(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
    }
  });

  it("rejects an oversized document with 413 and states the limit", () => {
    // The whole reason this endpoint has a parser: a client bug that PUTs a
    // growing blob on a timer must hit a wall, and the wall has to say where it
    // is or the client can only find it by trial.
    const huge = { blob: "x".repeat(CLIENT_SETTINGS_MAX_BYTES) };
    const result = parseClientSettingsBody(envelope(huge));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(413);
    expect(result.message).toContain(String(CLIENT_SETTINGS_MAX_BYTES));
    expect(result.message).toContain("256 KiB");
  });

  it("accepts a document sitting exactly on the limit", () => {
    // Off-by-one on a cap is a support ticket nobody can reproduce: the client
    // saves fine until one more hotkey tips it over by a byte.
    const overhead = JSON.stringify({ blob: "" }).length;
    const exact = { blob: "x".repeat(CLIENT_SETTINGS_MAX_BYTES - overhead) };
    const result = parseClientSettingsBody(envelope(exact));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.bytes).toBe(CLIENT_SETTINGS_MAX_BYTES);
  });

  it("measures bytes, not characters", () => {
    // A settings file full of Polish or emoji is measured as it is stored. Using
    // .length would let a payload nearly four times the cap through.
    const result = parseClientSettingsBody(envelope({ k: "\u{1F600}" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const canonical = JSON.stringify({ k: "\u{1F600}" });
    expect(result.bytes).toBeGreaterThan(canonical.length);
    expect(result.bytes).toBe(Buffer.byteLength(canonical, "utf8"));
  });

  it("refuses a NUL character instead of letting Postgres raise", () => {
    // jsonb has no way to hold one, so this would be a driver error on INSERT -
    // a 500 quoting Postgres at a client that is owed a 400 quoting the reason.
    const result = parseClientSettingsBody(envelope({ k: "a\u0000b" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("measures the settings, not the request, so indentation is not penalised", () => {
    // Clients pretty-print. A payload that fits once canonicalised must not be
    // refused for the whitespace it arrived with.
    const settings = { a: "x".repeat(1000), b: { c: [1, 2, 3] } };
    const pretty = JSON.stringify({ settings }, null, 4);
    const result = parseClientSettingsBody(pretty);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.bytes).toBeLessThan(Buffer.byteLength(pretty, "utf8"));
  });
});

describe("transport cap", () => {
  it("is looser than the storage cap but still bounded", () => {
    // The wire body carries the envelope and whatever spacing the client used,
    // so refusing at exactly the storage cap would reject payloads that fit.
    expect(CLIENT_SETTINGS_BODY_MAX_BYTES).toBeGreaterThan(CLIENT_SETTINGS_MAX_BYTES);
    expect(CLIENT_SETTINGS_BODY_MAX_BYTES).toBeLessThanOrEqual(CLIENT_SETTINGS_MAX_BYTES * 4);
  });

  it("still quotes the storage limit, which is the number a client can act on", () => {
    expect(bodyTooLargeMessage()).toContain(String(CLIENT_SETTINGS_MAX_BYTES));
  });
});
