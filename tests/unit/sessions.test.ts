import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The devices-and-sessions list on /dashboard/profile.
 *
 * Three properties are pinned here, all of which are quiet when broken:
 *
 *   1. The session TOKEN never leaves the server. It is the credential the
 *      cookie carries, so a row that reached the browser with its token still
 *      attached would turn this screen into a way to copy a sign-in out of the
 *      page source. Asserted against the serialised payload rather than against
 *      a named field, so a token re-added under any name fails the test.
 *   2. Exactly one row is marked `current`, and it sorts first. Without the
 *      mark every row looks alike and the owner signs themselves out.
 *   3. `describeDevice` never guesses. A wrong device name here is worse than
 *      no name at all, because the only question this screen answers is
 *      "is that one mine".
 */

const getSession = vi.fn();
const listSessions = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: { api: { getSession, listSessions } } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { describeDevice, listMySessions, mySessionToken } = await import("@/lib/data/sessions");

/** A Better Auth session row, carrying the fields this module reads. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    token: "tok-s1-secret",
    userId: "u1",
    createdAt: new Date("2026-08-01T10:00:00Z"),
    updatedAt: new Date("2026-08-18T10:00:00Z"),
    expiresAt: new Date("2026-08-25T10:00:00Z"),
    ipAddress: "203.0.113.7",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36",
    ...over,
  };
}

beforeEach(() => {
  getSession.mockReset();
  listSessions.mockReset();
});

describe("describeDevice", () => {
  it("reads Chrome on Windows without claiming a Windows version", () => {
    const d = describeDevice(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    );
    // Windows 10 and Windows 11 send the same token; picking one would be a lie.
    expect(d).toEqual({ browser: "Chrome 141", os: "Windows", kind: "desktop" });
  });

  it("does not report Edge as Chrome", () => {
    const d = describeDevice(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    );
    expect(d.browser).toBe("Edge 141");
  });

  it("does not report Opera as Chrome", () => {
    const d = describeDevice(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0",
    );
    expect(d.browser).toBe("Opera 125");
  });

  it("reads Safari on an iPhone as mobile", () => {
    const d = describeDevice(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
    );
    expect(d).toEqual({ browser: "Safari 18", os: "iOS 18", kind: "mobile" });
  });

  it("separates an Android tablet from an Android phone by the Mobile token", () => {
    const phone = describeDevice(
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36",
    );
    const tablet = describeDevice(
      "Mozilla/5.0 (Linux; Android 15; SM-X710) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36",
    );
    expect(phone.kind).toBe("mobile");
    expect(tablet.kind).toBe("tablet");
    expect(phone.os).toBe("Android 15");
  });

  it("names a non-browser client instead of the browser token it carries", () => {
    expect(describeDevice("ShareX/16.1.0").browser).toBe("ShareX 16.1.0");
    expect(describeDevice("curl/8.9.1")).toEqual({
      browser: "curl 8.9.1",
      os: null,
      kind: "client",
    });
  });

  it("returns nulls rather than a guess for a string it cannot read", () => {
    expect(describeDevice("something-nobody-has-seen")).toEqual({
      browser: null,
      os: null,
      kind: "unknown",
    });
    expect(describeDevice(null)).toEqual({ browser: null, os: null, kind: "unknown" });
    expect(describeDevice("   ")).toEqual({ browser: null, os: null, kind: "unknown" });
  });
});

describe("listMySessions", () => {
  it("never lets a session token reach the caller", async () => {
    getSession.mockResolvedValue({ session: { id: "s1" } });
    listSessions.mockResolvedValue([row(), row({ id: "s2", token: "tok-s2-secret" })]);

    const views = await listMySessions();
    const payload = JSON.stringify(views);

    expect(payload).not.toContain("tok-s1-secret");
    expect(payload).not.toContain("tok-s2-secret");
    expect(views.every((v) => !("token" in v))).toBe(true);
  });

  it("marks exactly the session doing the asking, and sorts it first", async () => {
    getSession.mockResolvedValue({ session: { id: "s2" } });
    listSessions.mockResolvedValue([
      row({ id: "s1", createdAt: new Date("2026-08-05T10:00:00Z") }),
      row({ id: "s2", createdAt: new Date("2026-08-01T10:00:00Z") }),
    ]);

    const views = await listMySessions();
    expect(views.map((v) => v.id)).toEqual(["s2", "s1"]);
    expect(views.filter((v) => v.current).map((v) => v.id)).toEqual(["s2"]);
  });

  it("orders the rest newest sign-in first", async () => {
    getSession.mockResolvedValue({ session: { id: "s1" } });
    listSessions.mockResolvedValue([
      row({ id: "s1" }),
      row({ id: "old", createdAt: new Date("2026-07-01T10:00:00Z") }),
      row({ id: "new", createdAt: new Date("2026-08-17T10:00:00Z") }),
    ]);

    expect((await listMySessions()).map((v) => v.id)).toEqual(["s1", "new", "old"]);
  });

  it("marks nothing current when the caller has no session", async () => {
    getSession.mockResolvedValue(null);
    listSessions.mockResolvedValue([row()]);
    expect((await listMySessions()).some((v) => v.current)).toBe(false);
  });

  it("clips an absurd User-Agent", async () => {
    getSession.mockResolvedValue({ session: { id: "s1" } });
    listSessions.mockResolvedValue([row({ userAgent: "A".repeat(5000) })]);

    const [v] = await listMySessions();
    expect(v.userAgent).toHaveLength(300);
  });

  it("reports a missing or blank address as null rather than as an empty string", async () => {
    getSession.mockResolvedValue({ session: { id: "s1" } });
    listSessions.mockResolvedValue([
      row({ id: "s1", ipAddress: "   " }),
      row({ id: "s2", ipAddress: null }),
      row({ id: "s3", ipAddress: undefined }),
    ]);

    for (const v of await listMySessions()) expect(v.ip).toBeNull();
  });

  it("flags a session opened by an administrator impersonating the account", async () => {
    getSession.mockResolvedValue({ session: { id: "s1" } });
    listSessions.mockResolvedValue([row({ id: "s1" }), row({ id: "s2", impersonatedBy: "admin-1" })]);

    const byId = new Map((await listMySessions()).map((v) => [v.id, v]));
    expect(byId.get("s1")!.impersonated).toBe(false);
    expect(byId.get("s2")!.impersonated).toBe(true);
  });

  it("emits ISO timestamps for all three moments", async () => {
    getSession.mockResolvedValue({ session: { id: "s1" } });
    listSessions.mockResolvedValue([row()]);

    const [v] = await listMySessions();
    expect(v.createdAt).toBe("2026-08-01T10:00:00.000Z");
    // updatedAt is a renewal stamp, not a last-seen time - see the module.
    expect(v.renewedAt).toBe("2026-08-18T10:00:00.000Z");
    expect(v.expiresAt).toBe("2026-08-25T10:00:00.000Z");
  });
});

describe("mySessionToken", () => {
  it("resolves an id that is in the caller's own list", async () => {
    listSessions.mockResolvedValue([row({ id: "s1", token: "tok-s1-secret" })]);
    expect(await mySessionToken("s1")).toBe("tok-s1-secret");
  });

  it("refuses an id that is not the caller's, which is the whole ownership check", async () => {
    // /list-sessions is scoped to the caller by Better Auth, so somebody else's
    // session id simply is not in this list - an administrator included.
    listSessions.mockResolvedValue([row({ id: "s1" })]);
    expect(await mySessionToken("somebody-elses-session")).toBeNull();
    expect(await mySessionToken("")).toBeNull();
  });
});
