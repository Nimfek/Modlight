import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The cache round-trip against the real storage driver.
 *
 * What is being protected is not "does a Buffer come back" but the two promises
 * the design makes: a derived file lives outside every user's tag (so no quota
 * arithmetic can ever see it) and one call removes everything derived from one
 * upload (so a delete cannot leave a downloadable copy behind).
 *
 * The driver is chosen from env at import time, hence the dynamic import.
 */
let cache: typeof import("@/lib/media/derived-cache");
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "modlight-derived-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_PATH = root;
  cache = await import("@/lib/media/derived-cache");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const UPLOAD_A = "11111111-1111-4111-8111-111111111111";
const UPLOAD_B = "22222222-2222-4222-8222-222222222222";

describe("the derived cache", () => {
  it("stores and returns bytes unchanged", async () => {
    const body = Buffer.from("%PDF-1.7 pretend conversion output");
    const key = cache.derivedKey(UPLOAD_A, cache.contentHash(body), "pdf", "pdf");

    expect(await cache.readDerived(key)).toBeNull(); // cold
    await cache.writeDerived(key, body);
    expect(Buffer.compare((await cache.readDerived(key))!, body)).toBe(0);
  });

  it("keeps every derived file outside the storage area quota is computed from", async () => {
    const body = Buffer.from("x");
    await cache.writeDerived(
      cache.derivedKey(UPLOAD_A, cache.contentHash(body), "png", "png"),
      body,
    );
    // One top-level directory, and it is not anybody's tag. Quota is maintained
    // from uploads.size, and no upload's storage key can ever start with this.
    const top = await readdir(root);
    expect(top).toEqual([cache.DERIVED_PREFIX]);
  });

  it("removes everything for one upload and nothing for its neighbour", async () => {
    const a = Buffer.from("belongs to A");
    const b = Buffer.from("belongs to B");
    const keysA = ["png", "pdf", "webp-anim"].map((v) =>
      cache.derivedKey(UPLOAD_A, cache.contentHash(a), v, v.split("-")[0]),
    );
    const keyB = cache.derivedKey(UPLOAD_B, cache.contentHash(b), "png", "png");

    for (const k of keysA) await cache.writeDerived(k, a);
    await cache.writeDerived(keyB, b);

    await cache.purgeDerived(UPLOAD_A);

    for (const k of keysA) expect(await cache.readDerived(k), k).toBeNull();
    expect(await cache.readDerived(keyB)).not.toBeNull();
  });

  it("treats purging an upload that never had a cache entry as success", async () => {
    await expect(cache.purgeDerived("33333333-3333-4333-8333-333333333333")).resolves
      .toBeUndefined();
  });

  it("misses rather than throws when the object is not there", async () => {
    expect(await cache.readDerived("derived/nope/nothing.png")).toBeNull();
  });
});
