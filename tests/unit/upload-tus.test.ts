import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "@tus/file-store";
import { Server as TusServer, Upload } from "@tus/server"; // @tus/utils is not a direct dep
import { discardTusUpload, sweepTusUploads, TUS_EXPIRATION_MS } from "@/lib/upload/tus";

/**
 * Regression cover for the orphaned sidecars found in production: `data/tus`
 * held 16 `.json` records whose payload had long since been moved into storage.
 * FileStore.deleteExpired() only ever collects *unfinished* uploads, so nothing
 * would have reclaimed them.
 */
const roots: string[] = [];

async function newStore(): Promise<FileStore> {
  const dir = await mkdtemp(join(tmpdir(), "modlight-tus-"));
  roots.push(dir);
  return new FileStore({ directory: dir, expirationPeriodInMilliseconds: TUS_EXPIRATION_MS });
}

afterAll(async () => {
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
});

describe("discardTusUpload", () => {
  it("removes both the payload and its sidecar for a store that still has them", async () => {
    const store = await newStore();
    await store.create(new Upload({ id: "abc123", size: 4, offset: 0 }));

    await discardTusUpload(store, "abc123");

    expect(await readdir(store.directory)).toEqual([]);
  });

  it("still drops the sidecar when finalize already moved the payload away", async () => {
    const store = await newStore();
    await store.create(new Upload({ id: "moved01", size: 4, offset: 0 }));
    // Exactly what finalizeUpload does: rename the temp file into storage.
    await rm(join(store.directory, "moved01"));

    await discardTusUpload(store, "moved01");

    // Without the configstore fallback this leaves "moved01.json" behind — the
    // production leak.
    expect(await readdir(store.directory)).toEqual([]);
  });

  it("is a no-op for an id the store never knew about", async () => {
    const store = await newStore();
    await expect(discardTusUpload(store, "ghost")).resolves.toBeUndefined();
  });

  it("does not touch unrelated uploads", async () => {
    const store = await newStore();
    await store.create(new Upload({ id: "keep01", size: 4, offset: 0 }));
    await store.create(new Upload({ id: "drop01", size: 4, offset: 0 }));
    await writeFile(join(store.directory, "keep01"), "data");

    await discardTusUpload(store, "drop01");

    const left = (await readdir(store.directory)).sort();
    expect(left).toEqual(["keep01", "keep01.json"]);
    expect((await stat(join(store.directory, "keep01"))).size).toBe(4);
  });
});

describe("sweepTusUploads", () => {
  /** Age a file past the reaper's grace period. */
  async function backdate(path: string, minutes: number) {
    const when = new Date(Date.now() - minutes * 60_000);
    await utimes(path, when, when);
  }

  it("reaps records the store's own list() cannot even see", async () => {
    const store = await newStore();
    // FileKvStore.list() only reports ids that still have BOTH files, so these
    // are invisible to deleteExpired() — exactly the 16 found in production.
    await writeFile(join(store.directory, "orphan1.json"), "{}");
    await backdate(join(store.directory, "orphan1.json"), 30);

    const server = new TusServer({ path: "/api/files", datastore: store });
    expect(await sweepTusUploads(server)).toBe(1);
    expect(await readdir(store.directory)).toEqual([]);
  });

  it("leaves a healthy in-progress upload alone", async () => {
    const store = await newStore();
    await store.create(new Upload({ id: "live01", size: 1024, offset: 0 }));
    await backdate(join(store.directory, "live01.json"), 30);

    const server = new TusServer({ path: "/api/files", datastore: store });
    expect(await sweepTusUploads(server)).toBe(0);
    expect((await readdir(store.directory)).sort()).toEqual(["live01", "live01.json"]);
  });

  it("respects the grace period for a record written moments ago", async () => {
    const store = await newStore();
    await writeFile(join(store.directory, "fresh01.json"), "{}");

    const server = new TusServer({ path: "/api/files", datastore: store });
    expect(await sweepTusUploads(server)).toBe(0);
    expect(await readdir(store.directory)).toEqual(["fresh01.json"]);
  });
});

describe("TUS_EXPIRATION_MS", () => {
  it("gives an interrupted upload a full day to be resumed", () => {
    // Long enough to survive an overnight sleep, short enough that a half-sent
    // 2 GB file (production has one) does not squat on the disk indefinitely.
    expect(TUS_EXPIRATION_MS).toBe(24 * 60 * 60 * 1000);
  });
});
