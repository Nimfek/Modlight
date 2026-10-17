import { afterAll, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, stat as fsStat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { LocalDriver } from "@/lib/storage/local";

// Unique temp root per run so parallel/repeat runs never collide.
const rootPromise = mkdtemp(join(tmpdir(), "modlight-storage-"));

async function getDriver(): Promise<{ driver: LocalDriver; root: string }> {
  const root = await rootPromise;
  return { driver: new LocalDriver(root), root };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

afterAll(async () => {
  const root = await rootPromise;
  await rm(root, { recursive: true, force: true });
});

describe("LocalDriver", () => {
  it("write(Buffer) then readBuffer round-trips", async () => {
    const { driver } = await getDriver();
    const key = "u1/round-trip.bin";
    const payload = randomBytes(4096);

    await driver.write(key, payload);
    const out = await driver.readBuffer(key);

    expect(Buffer.compare(out, payload)).toBe(0);
    expect(out.length).toBe(payload.length);
  });

  it("stat returns the correct size", async () => {
    const { driver } = await getDriver();
    const key = "u1/sized.bin";
    const payload = randomBytes(1234);

    await driver.write(key, payload);
    const s = await driver.stat(key);

    expect(s).not.toBeNull();
    expect(s?.size).toBe(1234);
  });

  it("stat returns null for a missing key", async () => {
    const { driver } = await getDriver();
    expect(await driver.stat("u1/does-not-exist.bin")).toBeNull();
  });

  it("exists reports true for present and false for absent keys", async () => {
    const { driver } = await getDriver();
    const key = "u2/present.bin";

    expect(await driver.exists(key)).toBe(false);
    await driver.write(key, Buffer.from("hello"));
    expect(await driver.exists(key)).toBe(true);
    expect(await driver.exists("u2/absent.bin")).toBe(false);
  });

  it("readStream with a byte range returns exactly that slice", async () => {
    const { driver } = await getDriver();
    const key = "u3/ranged.bin";
    const payload = randomBytes(2048);
    await driver.write(key, payload);

    // range is inclusive on both ends (see ByteRange in types.ts).
    const start = 100;
    const end = 299;
    const stream = await driver.readStream(key, { start, end });
    const got = await streamToBuffer(stream);

    const expected = payload.subarray(start, end + 1);
    expect(got.length).toBe(expected.length);
    expect(Buffer.compare(got, expected)).toBe(0);
  });

  it("readStream without a range returns the whole object", async () => {
    const { driver } = await getDriver();
    const key = "u3/whole.bin";
    const payload = randomBytes(777);
    await driver.write(key, payload);

    const got = await streamToBuffer(await driver.readStream(key));
    expect(Buffer.compare(got, payload)).toBe(0);
  });

  it("ingestLocalFile moves a temp file into place (source gone, dest readable)", async () => {
    const { driver, root } = await getDriver();

    // Stage a source file in a sibling temp dir (outside the storage root)
    // so we exercise the move, not an in-root no-op.
    const stageDir = join(root, "..", `modlight-ingest-src-${randomBytes(6).toString("hex")}`);
    await mkdir(stageDir, { recursive: true });
    const srcPath = join(stageDir, "incoming.bin");
    const payload = randomBytes(8192);
    await writeFile(srcPath, payload);

    try {
      const key = "u4/ingested.bin";
      await driver.ingestLocalFile(srcPath, key);

      // Source must be gone (rename, or copy+unlink fallback).
      await expect(fsStat(srcPath)).rejects.toMatchObject({ code: "ENOENT" });

      // Dest must be readable and byte-identical.
      const out = await driver.readBuffer(key);
      expect(Buffer.compare(out, payload)).toBe(0);
      expect(await driver.exists(key)).toBe(true);
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  });

  it("delete removes the object", async () => {
    const { driver } = await getDriver();
    const key = "u5/to-delete.bin";
    await driver.write(key, Buffer.from("delete me"));

    expect(await driver.exists(key)).toBe(true);
    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
    expect(await driver.stat(key)).toBeNull();
  });

  it("delete is a no-op for a missing key (force: true)", async () => {
    const { driver } = await getDriver();
    await expect(driver.delete("u5/never-existed.bin")).resolves.toBeUndefined();
  });

  it("a path-traversal key throws and does not write outside the root", async () => {
    const { driver, root } = await getDriver();
    const traversalKey = "../escape.bin";

    await expect(driver.write(traversalKey, Buffer.from("nope"))).rejects.toThrow(
      /traversal/i,
    );

    // Belt-and-suspenders: confirm nothing landed at the escaped location.
    const escapedPath = join(root, "..", "escape.bin");
    await expect(readFile(escapedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a deeper dot-dot escape also throws", async () => {
    const { driver } = await getDriver();
    await expect(
      driver.readBuffer("a/b/../../../etc/passwd"),
    ).rejects.toThrow(/traversal/i);
  });
});

describe("deletePrefix", () => {
  it("removes everything under the prefix and nothing beside it", async () => {
    // This is how a file's cached conversions go away with it: one call, without
    // the caller having to remember which variants were ever produced.
    const { driver } = await getDriver();
    await driver.write("derived/aaa/one.png", Buffer.from("1"));
    await driver.write("derived/aaa/two.pdf", Buffer.from("2"));
    await driver.write("derived/bbb/three.webp", Buffer.from("3"));
    await driver.write("u1/original.png", Buffer.from("4"));

    await driver.deletePrefix("derived/aaa/");

    expect(await driver.exists("derived/aaa/one.png")).toBe(false);
    expect(await driver.exists("derived/aaa/two.pdf")).toBe(false);
    expect(await driver.exists("derived/bbb/three.webp")).toBe(true);
    expect(await driver.exists("u1/original.png")).toBe(true);
  });

  it("treats a prefix with nothing under it as success", async () => {
    const { driver } = await getDriver();
    await expect(driver.deletePrefix("derived/never-existed/")).resolves.toBeUndefined();
  });

  it("refuses to empty the storage root", async () => {
    const { driver } = await getDriver();
    await expect(driver.deletePrefix("/")).rejects.toThrow(/storage root/i);
    await expect(driver.deletePrefix("")).rejects.toThrow(/storage root/i);
  });

  it("cannot be talked into deleting outside the root", async () => {
    const { driver } = await getDriver();
    await expect(driver.deletePrefix("../")).rejects.toThrow(/traversal/i);
    await expect(driver.deletePrefix("derived/../../etc/")).rejects.toThrow(/traversal/i);
  });
});
