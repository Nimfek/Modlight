import { describe, it, expect, vi, beforeEach } from "vitest";
import { tokenBanned, tokenInvalidScope, tokenOk, tokenScoped, tokenUnknown } from "../helpers/token-auth";

/**
 * Who may read `GET /api/admin/disk`, and what the refusals say.
 *
 * The endpoint hands one caller a listing of every account on the install, the
 * six biggest files on it and how full the machine is, so its door is the whole
 * feature. Three properties are pinned here, and each of them is a distinct way
 * the door could be left ajar by an edit that looks reasonable:
 *
 *  1. TWO gates, not one. Both the account's role and the credential's scope
 *     have to be satisfied. Dropping either check leaves a plausible-looking
 *     route that any administrator's ShareX token, or any user's `full` token,
 *     opens.
 *  2. A non-administrator gets 404, whatever it is holding. 403 would confirm
 *     that the endpoint exists and that this account is one rank away from it.
 *  3. A refusal costs nothing. The read models are six scans of `uploads`; if
 *     they run before the gate, an anonymous flood is a database flood.
 *
 * Proved by breaking rather than by review. Removing the role check turns three
 * of these red; asking for `read` instead of `admin` turns one red; answering a
 * non-administrator 403 instead of 404 turns five red. Each was run with the
 * damage in place before the damage was taken back out.
 */

const authenticateApiToken = vi.fn();
const getSession = vi.fn();
const serverStorageUsage = vi.fn();
const diskInsights = vi.fn();
const checkRateLimit = vi.fn();

vi.mock("@/lib/api-token", async () => {
  // The header parser and the refusal wording are the real ones: whether a
  // token was "offered" at all is the input to every branch under test.
  const actual = await vi.importActual<typeof import("@/lib/api-token")>("@/lib/api-token");
  return { ...actual, authenticateApiToken };
});
vi.mock("@/lib/auth-helpers", () => ({ getSession }));
vi.mock("@/lib/data/admin", () => ({ serverStorageUsage }));
// Only the query is doubled. The window constants stay real: they are part of
// what the route promises the client, and a test that invented its own would
// stop noticing the day one of them changed.
vi.mock("@/lib/data/admin-disk", async () => {
  const actual = await vi.importActual<typeof import("@/lib/data/admin-disk")>(
    "@/lib/data/admin-disk",
  );
  return { ...actual, diskInsights };
});
vi.mock("@/lib/password", async () => {
  const actual = await vi.importActual<typeof import("@/lib/password")>("@/lib/password");
  return { ...actual, checkRateLimit };
});

/** Nothing here queries; the route's own reads are mocked above. */
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
}));

const route = await import("@/app/api/admin/disk/route");

const URL_ = "https://host.example.com/api/admin/disk";

const ADMIN = { id: "admin-1", banned: false, role: "admin" };
const USER = { id: "user-1", banned: false, role: "user" };

const USAGE = {
  driver: "local",
  liveFiles: 8600,
  liveBytes: 5_000_000_000,
  trashedFiles: 12,
  trashedBytes: 40_000_000,
  disk: { totalBytes: 100_000_000_000, freeBytes: 60_000_000_000, usedBytes: 40_000_000_000 },
  minFreeBytes: 2_000_000_000,
};

const INSIGHTS = {
  driver: "local",
  local: true,
  kinds: [{ kind: "image", files: 8000, bytes: 3_000_000_000 }],
  kindBytes: 3_000_000_000,
  accounts: [
    {
      id: "user-1",
      name: "Nimfek",
      email: "n@example.com",
      tag: "AbCdE",
      orphaned: false,
      rest: false,
      accounts: 1,
      liveFiles: 8000,
      liveBytes: 4_000_000_000,
      trashedFiles: 1,
      trashedBytes: 10,
    },
  ],
  biggest: [
    {
      id: "f1",
      code: "wobura12",
      filename: "clip.mp4",
      ext: "mp4",
      mimeType: "video/mp4",
      size: 700_000_000,
      ownerId: "user-1",
      ownerTag: "AbCdE",
      ownerName: "Nimfek",
      createdAt: "2026-01-01T00:00:00.000Z",
      views: 3,
      lastAccessedAt: null,
    },
  ],
  cold: [
    {
      id: "f2",
      code: "hosade34",
      filename: "old.zip",
      ext: "zip",
      mimeType: "application/zip",
      size: 900_000,
      // An orphan: no owner, so no tag, so no public link to offer.
      ownerId: null,
      ownerTag: null,
      ownerName: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      views: 0,
      lastAccessedAt: null,
    },
  ],
  coldTotals: { files: 40, bytes: 1_000_000, days: 180 },
  trash: {
    files: 12,
    bytes: 40_000_000,
    oldest: "2026-08-01T00:00:00.000Z",
    dueSoonFiles: 2,
    dueSoonBytes: 5,
    overdueFiles: 0,
    overdueBytes: 0,
  },
};

function get(headers: Record<string, string> = {}): Request {
  return new Request(URL_, { headers });
}

beforeEach(() => {
  authenticateApiToken.mockReset();
  getSession.mockReset();
  serverStorageUsage.mockReset().mockResolvedValue(USAGE);
  diskInsights.mockReset().mockResolvedValue(INSIGHTS);
  checkRateLimit.mockReset().mockReturnValue({ allowed: true, retryAfterMs: 0 });
});

// ---------------------------------------------------------------------------
// Gate 1: the account
// ---------------------------------------------------------------------------

describe("the role gate", () => {
  it("refuses a non-administrator holding a perfectly good full-scope token", async () => {
    // The token is valid and as wide as tokens get. What it is missing is the
    // ACCOUNT behind it being an administrator, and that is the whole check.
    authenticateApiToken.mockResolvedValue(tokenOk(USER, "full"));

    const res = await route.GET(get({ "x-api-key": "wide-but-not-admin" }));

    expect(res.status).toBe(404);
    expect(serverStorageUsage).not.toHaveBeenCalled();
    expect(diskInsights).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-administrator", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", role: "user" } });
    expect((await route.GET(get())).status).toBe(404);
    expect(diskInsights).not.toHaveBeenCalled();
  });

  it("answers a non-administrator exactly as a missing route does", async () => {
    // Not merely the same status: the same response. `text/plain`, the body
    // `Not found`, and no cache-control - which is what Next itself returns for
    // a path with no route (checked against the deployment). A JSON body saying
    // "Not found." would have leaked by its SHAPE what the status was careful
    // not to say, because only a handwritten 404 has one.
    authenticateApiToken.mockResolvedValue(tokenOk(USER, "full"));
    const res = await route.GET(get({ "x-api-key": "wide-but-not-admin" }));

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    expect(await res.text()).toBe("Not found");
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("answers an administrator with an admin-scoped token", async () => {
    authenticateApiToken.mockResolvedValue(tokenOk(ADMIN, "full"));
    const res = await route.GET(get({ "x-api-key": "good" }));
    expect(res.status).toBe(200);
    expect(authenticateApiToken).toHaveBeenCalledWith("good", "admin");
  });
});

// ---------------------------------------------------------------------------
// Gate 2: the credential
// ---------------------------------------------------------------------------

describe("the scope gate", () => {
  it("refuses an administrator's write-scoped token", async () => {
    // The one case that says the two gates are really two. This account may do
    // anything on the server; this CREDENTIAL may not, and the credential is
    // the thing that leaks, because it lives in a config file on a laptop.
    authenticateApiToken.mockResolvedValue(tokenScoped(ADMIN, "write", "admin"));

    const res = await route.GET(get({ "x-api-key": "admins-desktop-token" }));

    expect(res.status).toBe(403);
    expect(serverStorageUsage).not.toHaveBeenCalled();

    // And it says which scope would have worked, because an administrator who
    // is only told "no" mints `full` for everything next time.
    const body = (await res.json()) as { reason: string; required_scope: string };
    expect(body.reason).toBe("insufficient_scope");
    expect(body.required_scope).toBe("full");
  });

  it("refuses an upload-scoped token, the one ShareX holds", async () => {
    authenticateApiToken.mockResolvedValue(tokenScoped(ADMIN, "upload", "admin"));
    expect((await route.GET(get({ "x-api-key": "sharex" }))).status).toBe(403);
  });

  it("gives a NON-administrator's narrow token a 404, not the scope explanation", async () => {
    // 403 here would be the leak the 404 exists to prevent, arriving by the
    // other door: "your token is too narrow FOR THIS" says the endpoint exists
    // and that a wider token of yours would open it.
    authenticateApiToken.mockResolvedValue(tokenScoped(USER, "write", "admin"));

    const res = await route.GET(get({ "x-api-key": "users-token" }));

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("refuses a token whose stored scope this build does not recognise", async () => {
    // Fails closed: there is no user on that branch, so administrator-ness
    // cannot be established, so it is not assumed.
    authenticateApiToken.mockResolvedValue(tokenInvalidScope());
    expect((await route.GET(get({ "x-api-key": "downgraded" }))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// No credential at all
// ---------------------------------------------------------------------------

describe("credential refusals stay 401", () => {
  it("refuses a request carrying neither a token nor a session", async () => {
    // 401 rather than 404 on purpose: every route on this surface answers 401
    // to an anonymous caller, so it says nothing about THIS route - and it is
    // the only thing that lets a desktop client tell "your token was revoked"
    // apart from "this server is too old to have the endpoint".
    getSession.mockResolvedValue(null);
    const res = await route.GET(get());
    expect(res.status).toBe(401);
    expect(diskInsights).not.toHaveBeenCalled();
  });

  it("refuses an unknown token WITHOUT falling through to a valid session", async () => {
    authenticateApiToken.mockResolvedValue(tokenUnknown());
    getSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });

    expect((await route.GET(get({ "x-api-key": "revoked" }))).status).toBe(401);
    expect((await route.GET(get({ authorization: "Bearer revoked" }))).status).toBe(401);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("refuses a banned administrator and says so", async () => {
    // Not 404: an administrator whose account was just switched off would go
    // looking for a server upgrade instead of asking why they are locked out.
    authenticateApiToken.mockResolvedValue(tokenBanned({ ...ADMIN, banned: true }));
    const res = await route.GET(get({ "x-api-key": "good" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Account disabled." });
  });

  it("treats an empty x-api-key as no token offered, and still shuts the door", async () => {
    getSession.mockResolvedValue(null);
    const res = await route.GET(get({ "x-api-key": "" }));
    expect(res.status).toBe(401);
    expect(authenticateApiToken).not.toHaveBeenCalled();
  });

  it("marks a credential refusal private, so no shared cache keeps one", async () => {
    // The 404 above deliberately carries no cache-control, because having one
    // would itself say "a route answered this". These refusals are JSON and
    // already announce themselves, so they keep the header.
    getSession.mockResolvedValue(null);
    const res = await route.GET(get());
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

describe("rate limit", () => {
  it("answers 429 with a Retry-After once an account exceeds its budget", async () => {
    authenticateApiToken.mockResolvedValue(tokenOk(ADMIN, "full"));
    checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 4200 });

    const res = await route.GET(get({ "x-api-key": "good" }));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
    // The point of the limit is the six scans NOT happening.
    expect(diskInsights).not.toHaveBeenCalled();
  });

  it("paces the account, not the address", async () => {
    authenticateApiToken.mockResolvedValue(tokenOk(ADMIN, "full"));
    await route.GET(get({ "x-api-key": "good" }));
    expect(checkRateLimit).toHaveBeenCalledWith("admin-disk:admin-1", 30, 60_000);
  });

  it("does not spend budget on a caller that was refused anyway", async () => {
    authenticateApiToken.mockResolvedValue(tokenOk(USER, "full"));
    await route.GET(get({ "x-api-key": "wide-but-not-admin" }));
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What an administrator actually gets
// ---------------------------------------------------------------------------

describe("the report", () => {
  async function report(): Promise<Record<string, unknown>> {
    authenticateApiToken.mockResolvedValue(tokenOk(ADMIN, "full"));
    const res = await route.GET(get({ "x-api-key": "good" }));
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * The shape the desktop client's `ModlightDiskReport` deserialises.
   *
   * Written out as a literal list rather than checked field by field, because
   * the failure being guarded against is a rename that still typechecks on this
   * side: Newtonsoft silently leaves an unmatched property at its default, so a
   * `liveBytes` that became `live_bytes` would reach the app's screen as a
   * confident, wrong zero rather than as an error anybody could see.
   */
  const CONTRACT = [
    "driver",
    "local",
    "liveFiles",
    "liveBytes",
    "trashedFiles",
    "trashedBytes",
    "disk",
    "minFreeBytes",
    "kinds",
    "kindBytes",
    "accounts",
    "biggest",
    "cold",
    "coldTotals",
    "trash",
    "trashRetentionDays",
    "trashDueSoonDays",
  ];

  it("answers in exactly the shape the client deserialises", async () => {
    expect(Object.keys(await report()).sort()).toEqual([...CONTRACT].sort());
  });

  it("splits what is stored into live and trash", async () => {
    const body = await report();
    expect(body.liveBytes).toBe(USAGE.liveBytes);
    expect(body.liveFiles).toBe(USAGE.liveFiles);
    expect(body.trashedBytes).toBe(USAGE.trashedBytes);
    expect(body.trashedFiles).toBe(USAGE.trashedFiles);
  });

  it("carries the filesystem measurement, whole", async () => {
    const body = await report();
    expect(body.local).toBe(true);
    expect(body.disk).toEqual(USAGE.disk);
    // The operator's floor travels too, or the client cannot say WHY a number
    // is alarming.
    expect(body.minFreeBytes).toBe(USAGE.minFreeBytes);
  });

  it("admits it cannot measure an object store rather than estimating one", async () => {
    // Rule 4: a count is not a measurement. On S3 there is no filesystem, and
    // what the bucket holds cannot be known without listing it - so `disk` is
    // null and `local` is false, which is exactly how the panel's own card
    // decides which of its two sentences to print.
    serverStorageUsage.mockResolvedValue({ ...USAGE, driver: "s3", disk: null });
    diskInsights.mockResolvedValue({ ...INSIGHTS, driver: "s3", local: false });

    const body = await report();

    expect(body.driver).toBe("s3");
    expect(body.local).toBe(false);
    expect(body.disk).toBeNull();
    // The row totals still travel: they are the honest half, and they are a
    // floor rather than a total.
    expect(body.liveBytes).toBe(USAGE.liveBytes);
  });

  it("carries the per-account, type, biggest and coldest breakdowns", async () => {
    const body = await report();
    expect(body.accounts).toEqual(INSIGHTS.accounts);
    expect(body.kinds).toEqual(INSIGHTS.kinds);
    expect(body.kindBytes).toBe(INSIGHTS.kindBytes);
    expect(body.biggest).toEqual(INSIGHTS.biggest);
    expect(body.cold).toEqual(INSIGHTS.cold);
    expect(body.coldTotals).toEqual(INSIGHTS.coldTotals);
    expect(body.trash).toEqual(INSIGHTS.trash);
  });

  it("sends this deployment's trash windows rather than letting a client assume", async () => {
    const body = await report();
    expect(body.trashRetentionDays).toBe(30);
    expect(body.trashDueSoonDays).toBe(7);
  });

  it("passes the cold list through with its nulls intact", async () => {
    // `lastAccessedAt: null` and an owner-less row are both facts the screen has
    // to render honestly. A route that coerced them to 0 and "" would make an
    // imported file look like one nobody has ever opened.
    const body = await report();
    const cold = body.cold as Array<{ lastAccessedAt: unknown; ownerTag: unknown }>;
    expect(cold[0].lastAccessedAt).toBeNull();
    expect(cold[0].ownerTag).toBeNull();
  });
});
