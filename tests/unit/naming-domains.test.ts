import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * lib/config reads process.env once at module load, so every case here has to
 * re-import it with a fresh module registry. `vi.resetModules()` + dynamic
 * import is what makes that possible without exporting a test-only setter.
 */
async function withEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const [{ config }, urls] = await Promise.all([import("@/lib/config"), import("@/lib/media/urls")]);
  return { config, urls, restore: () => Object.assign(process.env, previous) };
}

const HOST = "https://host.example.com";
const H = "https://h.example.com";
const S = "https://s.example.com";

let restore: (() => void) | undefined;

beforeEach(() => {
  restore = undefined;
});

afterEach(() => {
  restore?.();
  vi.resetModules();
});

describe("config.appDomains", () => {
  it("falls back to APP_URL alone when APP_DOMAINS is unset", async () => {
    const ctx = await withEnv({ APP_URL: HOST, APP_DOMAINS: undefined });
    restore = ctx.restore;
    expect(ctx.config.appDomains).toEqual([HOST]);
  });

  it("parses a comma-separated list with APP_URL first", async () => {
    const ctx = await withEnv({ APP_URL: HOST, APP_DOMAINS: `${H}, ${S}` });
    restore = ctx.restore;
    expect(ctx.config.appDomains).toEqual([HOST, H, S]);
  });

  it("normalises trailing slashes and drops duplicates", async () => {
    const ctx = await withEnv({ APP_URL: `${HOST}/`, APP_DOMAINS: `${HOST}//,${H}/,${H}` });
    restore = ctx.restore;
    expect(ctx.config.appDomains).toEqual([HOST, H]);
  });

  it("ignores empty entries from a trailing comma", async () => {
    const ctx = await withEnv({ APP_URL: HOST, APP_DOMAINS: `${H},,  ,` });
    restore = ctx.restore;
    expect(ctx.config.appDomains).toEqual([HOST, H]);
  });
});

describe("userBaseUrl", () => {
  it("returns the deployment default when no preference is stored", async () => {
    const ctx = await withEnv({ APP_URL: HOST, APP_DOMAINS: `${H},${S}` });
    restore = ctx.restore;
    expect(ctx.urls.userBaseUrl(null)).toBe(HOST);
    expect(ctx.urls.userBaseUrl(undefined)).toBe(HOST);
    expect(ctx.urls.userBaseUrl("")).toBe(HOST);
  });

  it("honours a configured domain", async () => {
    const ctx = await withEnv({ APP_URL: HOST, APP_DOMAINS: `${H},${S}` });
    restore = ctx.restore;
    expect(ctx.urls.userBaseUrl(H)).toBe(H);
    expect(ctx.urls.userBaseUrl(`${S}/`)).toBe(S);
  });

  it("refuses an origin the operator never configured", async () => {
    // The value is echoed into ShareX configs and OG tags — a stored origin
    // outside the allow-list must never make it into a generated link.
    const ctx = await withEnv({ APP_URL: HOST, APP_DOMAINS: H });
    restore = ctx.restore;
    expect(ctx.urls.userBaseUrl("https://evil.example.com")).toBe(HOST);
    expect(ctx.urls.isKnownDomain("https://evil.example.com")).toBe(false);
    expect(ctx.urls.isKnownDomain(H)).toBe(true);
  });

  it("self-heals when a domain is dropped from the configuration", async () => {
    const ctx = await withEnv({ APP_URL: HOST, APP_DOMAINS: undefined });
    restore = ctx.restore;
    // The account still points at h.example.com, but it is no longer served.
    expect(ctx.urls.userBaseUrl(H)).toBe(HOST);
  });
});

describe("URL builders with an explicit base", () => {
  it("build every public link on the supplied origin", async () => {
    const ctx = await withEnv({ APP_URL: HOST, APP_DOMAINS: H });
    restore = ctx.restore;
    const { publicUrl, rawUrl, downloadUrl, deleteUrl } = ctx.urls;

    expect(publicUrl("alicja", "funny-cat", "png", H)).toBe(`${H}/alicja/funny-cat.png`);
    expect(rawUrl("alicja", "funny-cat", "png", H)).toBe(`${H}/alicja/funny-cat/raw.png`);
    expect(downloadUrl("alicja", "funny-cat", H)).toBe(`${H}/alicja/funny-cat/download`);
    expect(deleteUrl("alicja", "funny-cat", "tok", H)).toBe(`${H}/alicja/funny-cat/delete/tok`);
  });

  it("defaults to APP_URL so untouched call sites are unaffected", async () => {
    const ctx = await withEnv({ APP_URL: HOST, APP_DOMAINS: H });
    restore = ctx.restore;
    expect(ctx.urls.publicUrl("alicja", "abc12", "png")).toBe(`${HOST}/alicja/abc12.png`);
    expect(ctx.urls.rawUrl("alicja", "abc12", "")).toBe(`${HOST}/alicja/abc12/raw`);
  });
});
