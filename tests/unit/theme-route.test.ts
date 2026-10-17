import { describe, it, expect, vi, beforeEach } from "vitest";
import { tokenOk } from "../helpers/token-auth";

/**
 * GET/PUT /api/theme, through the route handler.
 *
 * `tests/unit/theme-api.test.ts` pins the validation rules and
 * `tests/unit/api-route-auth.test.ts` pins the refusals. What is left, and what
 * this file is for, is the promise the desktop client is actually given: the
 * DATABASE is the setting. A write either lands in the column or is refused -
 * there is no third outcome where the endpoint answers 200 and the website goes
 * on painting the old skin.
 */

const authenticateApiToken = vi.fn();
const getSession = vi.fn();

vi.mock("@/lib/api-token", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-token")>("@/lib/api-token");
  return { ...actual, authenticateApiToken };
});
vi.mock("@/lib/auth-helpers", () => ({ getSession }));

/** Rows the next SELECT / UPDATE resolves to, and every `set()` that was attempted. */
let selectRows: unknown[] = [];
let updateRows: unknown[] = [];
let written: unknown[] = [];

/**
 * A Drizzle builder of any shape: every method returns the same thenable, so the
 * chain the route happens to write is accepted and awaits to `rows()`. `set` is
 * the one method with a side effect, because what it was handed is the whole
 * question - a refusal that still wrote something is the bug worth catching.
 */
function chain(rows: () => unknown[]): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
            Promise.resolve(rows()).then(ok, err);
        }
        if (prop === "catch") {
          return (err: (e: unknown) => unknown) => Promise.resolve(rows()).catch(err);
        }
        if (prop === "set") {
          return (value: unknown) => {
            written.push(value);
            return proxy;
          };
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => chain(() => selectRows),
    update: () => chain(() => updateRows),
    insert: () => chain(() => []),
    delete: () => chain(() => []),
  },
}));

const route = await import("@/app/api/theme/route");
const { THEME_IDS, DEFAULT_THEME } = await import("@/lib/themes");

const URL_ = "https://host.example.com/api/theme";
const KEY = { "x-api-key": "good" };

function get(): Request {
  return new Request(URL_, { headers: KEY });
}

function put(body: string): Request {
  return new Request(URL_, {
    method: "PUT",
    headers: { "content-type": "application/json", ...KEY },
    body,
  });
}

beforeEach(() => {
  authenticateApiToken.mockReset();
  getSession.mockReset();
  authenticateApiToken.mockResolvedValue(tokenOk({ id: "u1", banned: false, role: "user" }));
  selectRows = [];
  updateRows = [];
  written = [];
});

describe("GET /api/theme", () => {
  it("answers with the skin the column holds, plus the whole catalogue", async () => {
    selectRows = [{ theme: "terminal" }];
    const res = await route.GET(get());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.theme).toBe("terminal");
    // The list is the point of the endpoint: a client that hardcoded it goes
    // stale the first time this deployment gains a skin, and it has gained six
    // in one round already.
    expect(body.themes.map((t: { id: string }) => t.id)).toEqual([...THEME_IDS]);
    // Asserted against the constant, not a literal: what the default IS is a
    // product decision that has already changed once ("Late Night" replaced the
    // original violet look). What must never change is that the endpoint TELLS
    // the client, so a client does not have to guess.
    expect(body.defaultTheme).toBe(DEFAULT_THEME);
  });

  it("resolves a retired id, so a read-then-write round trip cannot 400", async () => {
    // Production rows still hold "modern" (it is the column default). Handing
    // that back raw would give a client a value its own picker cannot match and
    // that PUT would refuse a moment later.
    selectRows = [{ theme: "modern" }];
    expect((await (await route.GET(get())).json()).theme).toBe("default");
  });

  it("keeps the answer out of shared caches", async () => {
    selectRows = [{ theme: "paper" }];
    expect((await route.GET(get())).headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses when the account behind a live token has been deleted", async () => {
    selectRows = [];
    expect((await route.GET(get())).status).toBe(401);
  });
});

describe("PUT /api/theme", () => {
  it("writes the requested skin and answers with what the row holds", async () => {
    updateRows = [{ theme: "synthwave" }];
    const res = await route.PUT(put(JSON.stringify({ theme: "synthwave" })));

    expect(res.status).toBe(200);
    expect(written).toEqual([{ theme: "synthwave" }]);
    expect((await res.json()).theme).toBe("synthwave");
  });

  it("never writes an unknown skin", async () => {
    // The explicit requirement, and the fail-open shape to avoid: validating
    // with `resolveTheme` would have accepted this and stored the DEFAULT skin,
    // reporting success while resetting what the user had chosen.
    const res = await route.PUT(put(JSON.stringify({ theme: "hunter2" })));

    expect(res.status).toBe(400);
    expect(written).toEqual([]);
  });

  it("stores the canonical id for a retired one", async () => {
    updateRows = [{ theme: "default" }];
    const res = await route.PUT(put(JSON.stringify({ theme: "modern" })));

    expect(res.status).toBe(200);
    expect(written).toEqual([{ theme: "default" }]);
  });

  it("refuses an oversized body without writing", async () => {
    const res = await route.PUT(put(JSON.stringify({ theme: "x".repeat(8192) })));

    expect(res.status).toBe(413);
    expect(written).toEqual([]);
  });

  it("does not report success when the UPDATE matched no row", async () => {
    // The account was deleted while the token lived on. An UPDATE that matched
    // nothing is indistinguishable from a save until the next page load puts the
    // old skin back, which is exactly how "the picker does nothing" presented in
    // the panel.
    updateRows = [];
    expect((await route.PUT(put(JSON.stringify({ theme: "paper" })))).status).toBe(401);
  });
});
