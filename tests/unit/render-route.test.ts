import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "node:stream";

/**
 * `/{tag}/{code}/render`, through the route.
 *
 * This is the only place in the app where markup from an upload may come back
 * as text/html. One sentence has to be true of every answer it gives:
 *
 *   IF THE BODY IS THE UPLOADED DOCUMENT, THE RESPONSE CARRIES A SANDBOX CSP.
 *
 * If that can ever be false, the route is stored XSS on our own domain rather
 * than a feature: a script in the document would run in our origin and read the
 * session cookie of whoever opened the link. tests/unit/render-headers.test.ts
 * pins the copy of the policy that next.config applies; this file pins the
 * handler's own, and pins the gates that decide whether the body is served at
 * all.
 */

const isPrivilegedViewer = vi.fn();
const readStream = vi.fn();

vi.mock("@/lib/media/serve", () => ({
  getMedia: vi.fn(),
  isPrivilegedViewer,
  streamMedia: vi.fn(),
  consumeView: vi.fn(),
  cacheHeadersFor: () => ({}),
  codeFromMediaCode: (c: string) => c.split(".")[0],
}));

vi.mock("@/lib/storage", () => ({ getStorage: () => ({ readStream }) }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

/**
 * The handler runs two queries in a fixed order: the upload by id, then the
 * owner's tag. Answering by call order keeps the mock to a queue rather than a
 * re-implementation of Drizzle.
 */
let results: unknown[][] = [];
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => results.shift() ?? [] }),
      }),
    }),
  },
}));

const route = await import("@/app/[userCode]/[mediaCode]/[action]/route");
const { mintRenderTicket } = await import("@/lib/media/render-ticket");

const MEDIA_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOCUMENT = "<html><body><script>fetch('/api/me')</script></body></html>";

function htmlRow(over: Record<string, unknown> = {}) {
  return {
    id: MEDIA_ID,
    code: "abc123",
    ownerId: "owner-1",
    filename: "page.html",
    ext: "html",
    mimeType: "text/html",
    kind: "file",
    language: null,
    size: 4096,
    storageKey: "ToqOse/abc123.html",
    published: true,
    passwordHash: null,
    passwordVersion: null,
    expiresAt: null,
    maxViews: null,
    views: 1,
    deletedAt: null,
    ...over,
  };
}

/** Row + owner tag, in the order the handler asks for them. */
function seed(row: Record<string, unknown> = {}, tag = "ToqOse") {
  results = [[htmlRow(row)], [{ userCode: tag }]];
}

function call(
  opts: { ticket?: string | null; dest?: string | null; path?: string } = {},
): Promise<Response> {
  const ticket = opts.ticket === undefined ? mintRenderTicket(MEDIA_ID) : opts.ticket;
  const path = opts.path ?? "/ToqOse/abc123/render";
  const url = `https://h.example.com${path}${ticket ? `?t=${encodeURIComponent(ticket)}` : ""}`;
  const headers = new Headers();
  const dest = opts.dest === undefined ? "iframe" : opts.dest;
  if (dest) headers.set("sec-fetch-dest", dest);
  return route.GET(new Request(url, { headers }), {
    params: Promise.resolve({ userCode: "ToqOse", mediaCode: "abc123", action: "render" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isPrivilegedViewer.mockResolvedValue(false);
  readStream.mockImplementation(async () => Readable.from([Buffer.from(DOCUMENT, "utf8")]));
  seed();
});

describe("the rendered document", () => {
  it("comes back as HTML, in a sandbox", async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("<script>");

    const csp = res.headers.get("content-security-policy");
    expect(csp, "a document body without a sandbox policy is stored XSS").toBeTruthy();
    expect(csp).toContain("sandbox");
    expect(csp).not.toContain("allow-same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("is never cached or shared, because the gates it passed were about ONE viewer", async () => {
    const res = await call();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("vary")).toContain("Cookie");
  });

  it("carries a sandbox on every shape it will serve", async () => {
    for (const [mimeType, ext, type] of [
      ["text/html", "html", "text/html; charset=utf-8"],
      ["application/xhtml+xml", "xhtml", "text/html; charset=utf-8"],
      ["image/svg+xml", "svg", "image/svg+xml; charset=utf-8"],
    ] as const) {
      seed({ mimeType, ext, filename: `f.${ext}` });
      const res = await call();
      expect(res.status, mimeType).toBe(200);
      expect(res.headers.get("content-type"), mimeType).toBe(type);
      expect(res.headers.get("content-security-policy"), mimeType).toContain("sandbox");
    }
  });

  it("renders an HTML paste, whose type is declared by its language", async () => {
    // The owner's report: a paste saved as HTML. Its stored type used to be a
    // placeholder, and this handler looks the row up by id rather than through
    // getMedia, so without rowMimeType the toggle the preview page offers would
    // lead to a 404.
    seed({ kind: "paste", language: "html", mimeType: "text/plain; charset=utf-8", ext: "html" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("what the route refuses, with no body to sandbox", () => {
  it("refuses a top-level visit and sends the visitor to the preview page", async () => {
    // Without this the URL is a phishing page on our domain with our
    // certificate in the address bar, and it needs no scripting at all.
    const res = await call({ dest: "document" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ToqOse/abc123");
  });

  it("refuses a client that does not say what it is fetching for", async () => {
    const res = await call({ dest: null });
    expect(res.status).toBe(403);
  });

  it("refuses a hand-crafted URL with no ticket, or a forged one", async () => {
    expect((await call({ ticket: null })).status).toBe(403);
    expect((await call({ ticket: `${MEDIA_ID}.9999999999.forged` })).status).toBe(403);
  });

  it("refuses a ticket naming a file that is gone", async () => {
    // The id in the ticket is folded into the query, so a ticket for anything
    // else (or for a soft-deleted row) comes back with nothing to serve.
    results = [[]];
    const res = await call({ ticket: mintRenderTicket("cccccccc-cccc-4ccc-8ccc-cccccccccccc") });
    expect(res.status).toBe(404);
    expect(readStream).not.toHaveBeenCalled();
  });

  it("refuses to show one file under another file's address", async () => {
    // The ticket names the file and the URL must agree, or a link could display
    // any upload at any address on the site.
    seed({ code: "other99" });
    const res = await call();
    expect(res.status).toBe(404);
    expect(readStream).not.toHaveBeenCalled();
  });

  it("refuses a path that only decodes to /render", async () => {
    // Next matches its header rules against the RAW path while the App Router
    // hands this handler the decoded segment, so %72ender would arrive here as
    // action === "render" carrying the ordinary app-wide policy and no sandbox
    // at all. The handler refuses anything not spelled literally.
    const res = await call({ path: "/ToqOse/abc123/%72ender" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("text/html");
  });

  it("refuses an unpublished, expired or spent file to a stranger", async () => {
    seed({ published: false });
    expect((await call()).status).toBe(404);

    seed({ expiresAt: new Date(Date.now() - 1000) });
    expect((await call()).status).toBe(404);

    seed({ maxViews: 1, views: 2 });
    expect((await call()).status).toBe(404);
  });

  it("asks for the password the preview page asked for", async () => {
    seed({ passwordHash: "scrypt:whatever" });
    expect((await call()).status).toBe(401);
  });

  it("refuses a type that is not renderable markup", async () => {
    seed({ mimeType: "text/plain", ext: "txt", filename: "notes.txt" });
    expect((await call()).status).toBe(404);
    seed({ mimeType: "application/json", ext: "json", filename: "data.json" });
    expect((await call()).status).toBe(404);
  });

  it("refuses a document over the size ceiling", async () => {
    seed({ size: 6 * 1024 * 1024 });
    expect((await call()).status).toBe(413);
  });

  it("refuses a file rendered under somebody else's tag", async () => {
    seed({}, "SomeoneElse");
    expect((await call()).status).toBe(404);
  });

  it("never streams bytes on any of those paths", async () => {
    for (const opts of [
      { dest: "document" as const },
      { ticket: null },
      { path: "/ToqOse/abc123/%72ender" },
    ]) {
      seed();
      readStream.mockClear();
      await call(opts);
      expect(readStream).not.toHaveBeenCalled();
    }
  });
});
