import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * The URL grammar `/api/link-info` reads, pinned without a database.
 *
 * lib/config reads process.env once at module load, so each case re-imports it
 * with a fresh registry - the same shape tests/unit/naming-domains.test.ts uses.
 * That matters more here than usual: the shortener rewrite and the "is this even
 * our host" refusal both depend entirely on what APP_DOMAINS and SHORTLINK_URL
 * said at boot.
 */

const HOST = "https://host.example.com";
const H = "https://h.example.com";
const S = "https://s.example.com";

async function parser(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  const previous: Record<string, string | undefined> = {};
  const full = { APP_URL: HOST, APP_DOMAINS: `${HOST},${H}`, SHORTLINK_URL: S, ...env };
  for (const [k, v] of Object.entries(full)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import("@/lib/link-info/parse");
  return { ...mod, restore: () => Object.assign(process.env, previous) };
}

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
  vi.resetModules();
});

async function parse(url: string, env?: Record<string, string | undefined>) {
  const p = await parser(env);
  restore = p.restore;
  return p.parseLinkUrl(url);
}

function target(result: Awaited<ReturnType<typeof parse>>) {
  if (!result.ok) throw new Error(`expected a parse, got ${result.reason}: ${result.message}`);
  return result.target;
}

describe("the decorative extension", () => {
  it("cuts the code at the FIRST dot, so every spelling is one row", async () => {
    for (const spelling of ["romuz3", "romuz3.png", "romuz3.zzz", "romuz3.tar.gz", "romuz3."]) {
      const t = target(await parse(`${H}/alicja/${spelling}`));
      expect(t.kind).toBe("media");
      if (t.kind !== "media") return;
      expect(t.primary.code).toBe("romuz3");
      expect(t.primary.tag).toBe("alicja");
      expect(t.primary.shape).toBe("preview");
    }
  });

  it("reports the extension that was on the URL without letting it decide anything", async () => {
    const t = target(await parse(`${H}/alicja/romuz3.tar.gz`));
    if (t.kind !== "media") throw new Error("expected media");
    expect(t.primary.urlExt).toBe("tar.gz");
    expect(t.primary.code).toBe("romuz3");
  });
});

describe("the shapes the deployment serves", () => {
  it("reads every media action", async () => {
    const cases: [string, string][] = [
      ["raw", "raw"],
      ["raw.png", "raw"],
      ["download", "download"],
      ["convert", "convert"],
      ["render", "render"],
    ];
    for (const [segment, shape] of cases) {
      const t = target(await parse(`${H}/alicja/romuz3/${segment}`));
      if (t.kind !== "media") throw new Error("expected media");
      expect(t.primary.shape).toBe(shape);
    }
  });

  it("refuses an action the deployment does not serve, rather than guessing", async () => {
    const r = await parse(`${H}/alicja/romuz3/thumbnail`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unsupported-shape");
  });

  it("reads the tagless form as a code with no tag", async () => {
    const t = target(await parse(`${H}/romuz3.png`));
    if (t.kind !== "media") throw new Error("expected media");
    expect(t.primary.tag).toBeNull();
    expect(t.primary.code).toBe("romuz3");
  });

  it("reads short links in both spellings", async () => {
    const root = target(await parse(`${HOST}/s/promo`));
    expect(root).toMatchObject({ kind: "shortlink", stored: "promo", unlockGate: false });

    const scoped = target(await parse(`${HOST}/s/alicja/promo`));
    expect(scoped).toMatchObject({ kind: "shortlink", stored: "alicja/promo" });

    const gate = target(await parse(`${HOST}/s/alicja/promo/unlock`));
    expect(gate).toMatchObject({ kind: "shortlink", stored: "alicja/promo", unlockGate: true });
  });

  it("reads galleries", async () => {
    expect(target(await parse(`${HOST}/a/alicja/wakacje`))).toMatchObject({
      kind: "folder-gallery",
      tag: "alicja",
      slug: "wakacje",
      zip: false,
    });
    expect(target(await parse(`${HOST}/a/alicja/wakacje/zip`))).toMatchObject({ zip: true });
    expect(target(await parse(`${HOST}/u/alicja`))).toMatchObject({
      kind: "user-gallery",
      tag: "alicja",
    });
  });
});

describe("the two-segment ambiguity", () => {
  /**
   * /{tag}/{code} and /{code}/raw are the same shape. The app tries the tagged
   * reading first and falls back, so both readings have to come back in that
   * order - a parser that picked one would describe the wrong file for whichever
   * case it guessed wrong.
   */
  it("offers the tagged reading first and the tagless action as a fallback", async () => {
    const t = target(await parse(`${H}/romuz3/raw.png`));
    if (t.kind !== "media") throw new Error("expected media");
    expect(t.primary).toMatchObject({ tag: "romuz3", code: "raw", shape: "preview" });
    expect(t.fallback).toMatchObject({ tag: null, code: "romuz3", shape: "raw" });
  });

  it("offers no fallback when the second segment is not a tagless action", async () => {
    const t = target(await parse(`${H}/alicja/romuz3.png`));
    if (t.kind !== "media") throw new Error("expected media");
    expect(t.fallback).toBeUndefined();
  });

  it("does not offer /render as a tagless fallback, because the app does not", async () => {
    const t = target(await parse(`${H}/romuz3/render`));
    if (t.kind !== "media") throw new Error("expected media");
    expect(t.fallback).toBeUndefined();
  });
});

describe("reserved names", () => {
  it("never reads a reserved first segment as a tag", async () => {
    for (const path of ["/login", "/dashboard/files", "/api/uploads", "/oembed"]) {
      const t = target(await parse(`${HOST}${path}`));
      expect(t.kind).toBe("app-route");
    }
  });

  it("never reads a reserved code as a tagless file", async () => {
    const r = await parse(`${HOST}/login.png`);
    expect(r.ok).toBe(false);
  });

  it("labels the routes a caller is most likely to paste", async () => {
    const t = target(await parse(`${HOST}/download/app`));
    if (t.kind !== "app-route") throw new Error("expected app-route");
    expect(t.label).toContain("desktop app");
  });
});

describe("the shortener host", () => {
  /**
   * On s.example.com proxy.ts rewrites every path to /s{path}. Without mirroring
   * that, this endpoint would look up s.example.com/promo as a media code and answer
   * "not found" about a short link that works perfectly.
   */
  it("reads a bare path on the short domain as a short link", async () => {
    const r = await parse(`${S}/promo`);
    if (!r.ok) throw new Error("expected a parse");
    expect(r.target).toMatchObject({ kind: "shortlink", stored: "promo" });
    expect(r.path).toBe("/s/promo");
    expect(r.warnings.join(" ")).toContain("short link domain");
  });

  it("leaves the passthrough paths alone on the short domain", async () => {
    const r = await parse(`${S}/api/health`);
    if (!r.ok) throw new Error("expected a parse");
    expect(r.path).toBe("/api/health");
    expect(r.target.kind).toBe("app-route");
  });

  it("does not rewrite the same path on an app host", async () => {
    const r = await parse(`${H}/promo`);
    if (!r.ok) throw new Error("expected a parse");
    expect(r.target.kind).toBe("media");
  });

  /**
   * The ordinary single-domain install, and the case that caught a real bug:
   * config.shortUrl falls back to APP_URL when SHORTLINK_URL is unset, so a
   * naive read of it made every path on the main domain a short link. proxy.ts
   * installs no rewrite in that configuration, and neither must this.
   */
  it("installs no rewrite at all when SHORTLINK_URL is unset", async () => {
    const login = await parse(`${HOST}/login`, { SHORTLINK_URL: undefined });
    if (!login.ok) throw new Error("expected a parse");
    expect(login.path).toBe("/login");
    expect(login.target.kind).toBe("app-route");

    const file = await parse(`${HOST}/alicja/romuz3.png`, { SHORTLINK_URL: undefined });
    if (!file.ok) throw new Error("expected a parse");
    expect(file.path).toBe("/alicja/romuz3.png");
    expect(file.target.kind).toBe("media");
    expect(file.warnings).toEqual([]);
  });
});

describe("refusals", () => {
  it("refuses a host that is not this deployment", async () => {
    const r = await parse("https://evil.example.com/alicja/romuz3.png");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("foreign-host");
    expect(r.message).toContain("evil.example.com");
  });

  it("refuses a non-web scheme instead of trying to parse it", async () => {
    for (const url of ["javascript:alert(1)", "data:text/html,<b>", "file:///etc/passwd"]) {
      const r = await parse(url);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("unparseable");
    }
  });

  /**
   * A deletion link is a capability: the token in it is the whole authorisation
   * and one POST destroys the file. Refused by SHAPE, before any lookup, so this
   * endpoint can neither hand one on nor be used to test guessed tokens.
   */
  it("refuses a deletion link by shape", async () => {
    const r = await parse(`${H}/alicja/romuz3/delete/sometoken`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("capability-url");
    expect(r.message).toContain("Do not POST");
  });

  it("refuses an empty input and an oversized one", async () => {
    expect((await parse("")).ok).toBe(false);
    expect((await parse(`${H}/${"a".repeat(4000)}`)).ok).toBe(false);
  });
});

describe("input shapes a person actually pastes", () => {
  it("accepts a bare path", async () => {
    const r = await parse("/alicja/romuz3.png");
    if (!r.ok) throw new Error("expected a parse");
    expect(r.origin).toBe(HOST);
    expect(r.target).toMatchObject({ kind: "media" });
  });

  it("accepts a URL whose scheme the browser hid", async () => {
    const r = await parse("h.example.com/alicja/romuz3.png");
    if (!r.ok) throw new Error("expected a parse");
    expect(r.origin).toBe(H);
  });

  it("accepts http for a host served over https, rather than being pedantic", async () => {
    const r = await parse("http://h.example.com/alicja/romuz3.png");
    expect(r.ok).toBe(true);
  });

  it("keeps the query string for the caller to see", async () => {
    const r = await parse(`${H}/alicja/romuz3/convert?to=webp&check=1`);
    if (!r.ok) throw new Error("expected a parse");
    expect(r.search).toBe("?to=webp&check=1");
  });
});
