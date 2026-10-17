import { describe, it, expect, vi, beforeEach } from "vitest";
import { tokenBanned, tokenOk, tokenUnknown } from "../helpers/token-auth";

/**
 * The refusals on the desktop client's HTTP surface, asserted through the ROUTE
 * HANDLERS rather than through the helper they were supposed to call.
 *
 * `tests/unit/api-caller.test.ts` already pins `resolveApiCaller`, and
 * `/api/client-settings` uses it. `/api/uploads` and `/api/shortlinks` do not:
 * each carries its own private copy of the same three lines, written before the
 * helper existed. A security check with three implementations has three chances
 * to be edited wrong and no test that notices, so the check is exercised here
 * where a client actually meets it - once per endpoint, not once per helper.
 *
 * The case that matters most is a token that is PRESENT and wrong arriving
 * alongside a perfectly good session cookie. Written the obvious way ("try the
 * token, then try the session") every one of these routes would answer 200 with
 * somebody's real library to a caller whose credential had just been rejected.
 */

const authenticateApiToken = vi.fn();
const getSession = vi.fn();

vi.mock("@/lib/api-token", async () => {
  // The header parser is the real one on purpose: it decides whether a token was
  // "offered" at all, which is the input to every branch under test.
  const actual = await vi.importActual<typeof import("@/lib/api-token")>("@/lib/api-token");
  return { ...actual, authenticateApiToken };
});
vi.mock("@/lib/auth-helpers", () => ({ getSession }));

/**
 * Rows the next query resolves to, whatever the query is.
 *
 * Every Drizzle builder method returns the same thenable, so a chain of any
 * shape is accepted and awaits to `rows`. That is enough for these tests because
 * a refusal happens BEFORE the first query in all but one case - and that case
 * (a banned account reached through the session) is precisely the one worth
 * proving does not get past its single SELECT.
 */
let rows: unknown[] = [];

function chainable(): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(ok, err);
        }
        if (prop === "catch") {
          return (err: (e: unknown) => unknown) => Promise.resolve(rows).catch(err);
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => chainable(),
    insert: () => chainable(),
    update: () => chainable(),
    delete: () => chainable(),
  },
}));

const uploads = await import("@/app/api/uploads/route");
const folders = await import("@/app/api/folders/route");
const shortlinks = await import("@/app/api/shortlinks/route");
const clientSettings = await import("@/app/api/client-settings/route");
const theme = await import("@/app/api/theme/route");

const URLS = {
  uploads: "https://host.example.com/api/uploads",
  folders: "https://host.example.com/api/folders",
  shortlinks: "https://host.example.com/api/shortlinks",
  clientSettings: "https://host.example.com/api/client-settings",
  theme: "https://host.example.com/api/theme",
};

function get(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

function body(url: string, method: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ target: "https://example.com", settings: {} }),
  });
}

/** Every reader on the surface, so a new one cannot be added without a row here. */
const READERS: Array<[string, () => Request, (r: Request) => Promise<Response>]> = [
  ["GET /api/uploads", () => get(URLS.uploads), (r) => uploads.GET(r)],
  ["GET /api/folders", () => get(URLS.folders), (r) => folders.GET(r)],
  ["GET /api/shortlinks", () => get(URLS.shortlinks), (r) => shortlinks.GET(r)],
  ["GET /api/client-settings", () => get(URLS.clientSettings), (r) => clientSettings.GET(r)],
  ["GET /api/theme", () => get(URLS.theme), (r) => theme.GET(r)],
];

/**
 * Every writer. A write refused late is a write that happened.
 *
 * The folder verbs are listed here for the same reason the readers are - so a
 * new endpoint cannot join the surface without a row - even though
 * tests/unit/folders-api.test.ts drives them end to end against a database
 * double. This file answers "is the door shut"; that one answers "and what
 * happens once you are through it".
 */
const WRITERS: Array<[string, () => Request, (r: Request) => Promise<Response>]> = [
  ["POST /api/shortlinks", () => body(URLS.shortlinks, "POST"), (r) => shortlinks.POST(r)],
  ["POST /api/folders", () => body(URLS.folders, "POST"), (r) => folders.POST(r)],
  ["PATCH /api/folders", () => body(URLS.folders, "PATCH"), (r) => folders.PATCH(r)],
  ["DELETE /api/folders", () => body(URLS.folders, "DELETE"), (r) => folders.DELETE(r)],
  ["PATCH /api/uploads", () => body(URLS.uploads, "PATCH"), (r) => uploads.PATCH(r)],
  ["PUT /api/client-settings", () => body(URLS.clientSettings, "PUT"), (r) => clientSettings.PUT(r)],
  ["PUT /api/theme", () => body(URLS.theme, "PUT"), (r) => theme.PUT(r)],
];

const ALL = [...READERS, ...WRITERS];

function withHeaders(req: Request, headers: Record<string, string>): Request {
  const merged = new Headers(req.headers);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  return new Request(req, { headers: merged });
}

beforeEach(() => {
  authenticateApiToken.mockReset();
  getSession.mockReset();
  rows = [];
});

describe.each(ALL)("%s", (_name, make, call) => {
  it("refuses a request carrying neither a token nor a session", async () => {
    getSession.mockResolvedValue(null);
    expect((await call(make())).status).toBe(401);
  });

  it("refuses an invalid token WITHOUT falling through to the session", async () => {
    // The session is deliberately valid. If the fallback ran, a desktop client
    // holding a revoked key would keep reading and writing whichever account the
    // browser sharing its cookie jar was signed into.
    authenticateApiToken.mockResolvedValue(tokenUnknown());
    getSession.mockResolvedValue({ user: { id: "session-user", role: "admin" } });

    const offers: Record<string, string>[] = [
      { "x-api-key": "revoked" },
      { authorization: "Bearer revoked" },
    ];
    for (const headers of offers) {
      expect((await call(withHeaders(make(), headers))).status).toBe(401);
    }
    expect(getSession).not.toHaveBeenCalled();
  });

  it("refuses a banned account holding a working token", async () => {
    // Disabling an account does not delete its tokens: `api_tokens` has no
    // notion of a disabled owner, so this check exists only in the route.
    authenticateApiToken.mockResolvedValue(tokenBanned({ id: "u1", banned: true, role: "user" }));
    expect((await call(withHeaders(make(), { "x-api-key": "good" }))).status).toBe(401);
  });

  it("refuses an empty x-api-key when there is no session behind it", async () => {
    // An empty header reads as "no token offered" (see bearerFromRequest), which
    // is right - but it must then meet the same closed door as no header at all,
    // not an open one.
    getSession.mockResolvedValue(null);
    const res = await call(withHeaders(make(), { "x-api-key": "" }));
    expect(res.status).toBe(401);
    expect(authenticateApiToken).not.toHaveBeenCalled();
  });

  it("marks the refusal private, so no shared cache keeps it", async () => {
    getSession.mockResolvedValue(null);
    const res = await call(make());
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("GET /api/uploads, session path", () => {
  it("refuses a banned account that still holds a session cookie", async () => {
    // Better Auth will not hand a banned account a fresh session, but an issued
    // one outlives the ban, and this route reads the whole user row anyway. The
    // single SELECT it makes must be the end of the request, not the start of a
    // listing.
    getSession.mockResolvedValue({ user: { id: "u2" } });
    rows = [{ id: "u2", banned: true, userCode: "AbCdE", copyRaw: false }];

    expect((await uploads.GET(get(URLS.uploads))).status).toBe(401);
  });

  it("refuses a session whose user row has since been deleted", async () => {
    getSession.mockResolvedValue({ user: { id: "ghost" } });
    rows = [];
    expect((await uploads.GET(get(URLS.uploads))).status).toBe(401);
  });
});

describe("POST /api/shortlinks, cross-origin defence", () => {
  it("refuses a body that is not application/json", async () => {
    // The Content-Type is the CSRF control: `text/plain` is CORS-safelisted, so
    // a stranger's page could post one at a logged-in visitor without a
    // preflight, and JSON.parse would accept it happily.
    authenticateApiToken.mockResolvedValue(tokenOk({ id: "u1", banned: false }));
    const req = new Request(URLS.shortlinks, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", "x-api-key": "good" },
      body: JSON.stringify({ target: "https://evil.example" }),
    });
    expect((await shortlinks.POST(req)).status).toBe(415);
  });

  it("checks the credential BEFORE the body, so an anonymous flood is cheap", async () => {
    getSession.mockResolvedValue(null);
    const req = new Request(URLS.shortlinks, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json at all",
    });
    // 401, not 415: an unauthenticated caller learns nothing about the parser.
    expect((await shortlinks.POST(req)).status).toBe(401);
  });
});

describe("client-settings discriminator", () => {
  it("refuses a client kind that is not on the allowlist", async () => {
    // The discriminator is half of the table's primary key. Taken from the query
    // string it would let one account own as many rows as a client cares to
    // invent, and the per-row byte cap would stop bounding anything.
    authenticateApiToken.mockResolvedValue(tokenOk({ id: "u1", banned: false }));
    const res = await clientSettings.GET(
      get(`${URLS.clientSettings}?client=mobile`, { "x-api-key": "good" }),
    );
    expect(res.status).toBe(400);
  });
});
