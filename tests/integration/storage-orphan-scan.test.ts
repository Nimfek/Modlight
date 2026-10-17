import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What the "unreferenced bytes on disk" report counts, and what it must not.
 *
 * The scan walks storage and reports every file no `uploads` row points at.
 * Three trees deliberately have no such row - cached conversions, wallpapers and
 * avatars - so without an exclusion list every single one of them is reported as
 * dead weight. That is not a harmless inaccuracy: the report exists so an
 * operator can act on it by hand, and a report that always names every account's
 * decoration is one they learn to scroll past, which is how the real orphan in
 * the middle of it gets missed.
 *
 * Run against a real directory rather than a mocked fs: the thing under test IS
 * a directory walk, and the interesting part is which entries it descends into.
 */

let root = "";
let knownRows: { storageKey: string; thumbKey: string | null }[] = [];

vi.mock("@/lib/config", () => ({
  config: {
    get storage() {
      return { driver: "local" as const, localPath: root };
    },
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => Promise.resolve(knownRows),
    }),
  },
}));

const { scanStorageOrphans } = await import("@/lib/data/admin");
const { BACKGROUND_PREFIX } = await import("@/lib/background");
const { AVATAR_PREFIX } = await import("@/lib/avatar");
const { DERIVED_PREFIX } = await import("@/lib/media/derived-cache");

/** Written far enough in the past to clear the scan's grace window. */
async function put(relative: string, body = "bytes"): Promise<void> {
  const full = join(root, ...relative.split("/"));
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, body);
  const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await utimes(full, old, old);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "modlight-scan-"));
  knownRows = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scanStorageOrphans", () => {
  it("reports a file no row points at", async () => {
    await put("alicja/left-behind.png");

    const result = await scanStorageOrphans();
    expect(result.supported).toBe(true);
    expect(result.orphans).toBe(1);
    expect(result.sample.map((s) => s.key)).toEqual(["alicja/left-behind.png"]);
  });

  it("says nothing about a file a row does point at", async () => {
    await put("alicja/kept.png");
    knownRows = [{ storageKey: "alicja/kept.png", thumbKey: null }];

    expect((await scanStorageOrphans()).orphans).toBe(0);
  });

  it("never reports per-account decoration or cached conversions", async () => {
    // None of these will ever have an `uploads` row: avatars and wallpapers are
    // kept out of that table on purpose (they must not appear in a dashboard,
    // count against a quota, or be reachable at a /{tag}/{code} link), and
    // derived objects are keyed by content. Each is freed by the feature that
    // wrote it.
    await put(`${AVATAR_PREFIX}/user_1-abc123.webp`);
    await put(`${BACKGROUND_PREFIX}/user_1-def456.webp`);
    await put(`${DERIVED_PREFIX}/some-upload-id/webp-256.webp`);

    const result = await scanStorageOrphans();
    expect(result.orphans).toBe(0);
    expect(result.sample).toEqual([]);
    // Not merely filtered out of the sample: never opened at all.
    expect(result.scanned).toBe(0);
  });

  it("still finds a real orphan sitting beside the excluded trees", async () => {
    await put(`${AVATAR_PREFIX}/user_1-abc123.webp`);
    await put("alicja/actually-garbage.png");

    const result = await scanStorageOrphans();
    expect(result.orphans).toBe(1);
    expect(result.sample.map((s) => s.key)).toEqual(["alicja/actually-garbage.png"]);
  });

  it("excludes only the TOP-LEVEL trees, not a user tag that happens to match", async () => {
    // A tag called "avatars" is reserved now (lib/naming.ts), but a directory
    // nested under a real tag must not inherit the exemption - otherwise the
    // exclusion becomes a way to hide bytes from the report.
    await put(`alicja/${AVATAR_PREFIX}/sneaky.png`);

    expect((await scanStorageOrphans()).orphans).toBe(1);
  });
});
