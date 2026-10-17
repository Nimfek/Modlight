import { afterAll, describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * `readHead` is what lets the upload pipeline identify a file it did not stream
 * itself (the resumable path) without reading it back in full - so the property
 * that matters is that a huge object costs the same as a tiny one.
 *
 * The storage driver is chosen from env at import time, hence the dynamic import.
 */
let readHead: typeof import("@/lib/storage").readHead;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "modlight-head-"));
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_PATH = root;
  ({ readHead } = await import("@/lib/storage"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readHead", () => {
  it("reads only the requested prefix of a large object", async () => {
    await mkdir(join(root, "u1"), { recursive: true });
    const payload = Buffer.concat([Buffer.from("%PDF-1.7"), randomBytes(8 * 1024 * 1024)]);
    await writeFile(join(root, "u1", "big.pdf"), payload);

    const head = await readHead("u1/big.pdf", 4096);
    expect(head.length).toBe(4096);
    expect(Buffer.compare(head, payload.subarray(0, 4096))).toBe(0);
  });

  it("returns everything there is when the file is shorter than the window", async () => {
    await writeFile(join(root, "u1", "small.txt"), "hello");
    const head = await readHead("u1/small.txt", 4096);
    expect(head.toString()).toBe("hello");
  });

  it("returns nothing rather than throwing when the bytes are missing", async () => {
    // A row whose file has gone is a reason to fall back to other evidence, not
    // a reason to fail an upload whose bytes are already safe.
    expect((await readHead("u1/does-not-exist.bin")).length).toBe(0);
    expect((await readHead("../escape.bin")).length).toBe(0);
  });
});
