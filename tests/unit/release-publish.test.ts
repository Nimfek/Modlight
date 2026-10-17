import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The publish script, end to end, plus the gate it now has to pass through.
 *
 * The bug this file pins: the script never computed a checksum. `finalizeUpload`
 * stores the sha256 its CALLER hands it, and this caller handed it nothing, so
 * `uploads.checksum` stayed NULL and the manifest promised `sha256: null`. The
 * desktop updater refuses an update with no digest - fail-closed, and correctly
 * so - which means two consecutive releases were published that no installed
 * copy would ever accept, and both digests had to be patched in by hand.
 *
 * So the thing worth testing is not "does it hash a file" but "can a manifest
 * without a digest still come out of this path". It cannot, and that is asserted
 * twice over: once against `publishVerifiedRelease` directly, and once by
 * running the whole script with a row whose checksum is missing and checking
 * that the settings key is never written.
 */

/**
 * Env has to be in place before @/lib/config snapshots it, and config is pulled
 * in by the very first dynamic import below - so this runs in `vi.hoisted`,
 * which executes ahead of every import in the file.
 */
const STAGE_DIR = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || "/tmp";
  const dir = `${base}/modlight-release-stage-${Date.now()}`.replace(/\\/g, "/");
  process.env.UPLOAD_TMP_PATH = dir;
  // The staged copy is a few dozen bytes. Without this the production 10 GiB
  // free-space reserve would decide the test by how full the machine happens to
  // be, which is the kind of test that gets deleted rather than fixed.
  process.env.MIN_FREE_DISK_BYTES = "0";
  return dir;
});

const SRC_DIR = mkdtempSync(join(tmpdir(), "modlight-release-src-"));

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

/** Answers, in the order the code asks for them. */
const rows: Record<string, unknown>[][] = [];
const settings = new Map<string, string | null>();
const finalizeMock = vi.fn();

/**
 * Just enough Drizzle to run the real functions. Same reasoning as
 * tests/unit/release-version.test.ts: every query here is a single-table,
 * single-row lookup, so what a fake must get right is the ORDER of the answers.
 */
vi.mock("@/lib/db", () => {
  const chain = () => {
    const self: Record<string, unknown> = {};
    for (const method of ["from", "where", "limit", "orderBy"]) self[method] = () => self;
    self.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows.shift() ?? []).then(resolve);
    return self;
  };
  return { db: { select: () => chain() } };
});

vi.mock("@/lib/settings", () => ({
  getSetting: async (key: string) => settings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => {
    settings.set(key, value);
  },
}));

vi.mock("@/lib/upload/finalize", () => ({
  finalizeUpload: (input: unknown) => finalizeMock(input),
}));

// Dynamic, and after the containers above exist: a static import would be
// evaluated before them, the mock factories would run inside it, and `rows`
// would still be in its temporal dead zone.
const { isReleaseDigest, publishVerifiedRelease, releaseFileName } = await import(
  "@/lib/releases-core"
);

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const INSTALLER = "Modlight-0.7.2-setup-x64.exe";
/** Starts with MZ so the MIME sniff sees a real installer. */
const PAYLOAD = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(2048, 7)]);
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");

const ACCOUNT = {
  id: "admin-id",
  email: "admin@example.com",
  userCode: "alicja",
  hideUploads: false,
  copyRaw: false,
};

/**
 * The upload row `publishRelease` inspects, then the two `currentRelease` reads.
 *
 * The first row carries `checksum` as well, which `publishRelease` ignores. That
 * is what lets the "no digest" test below be a real test: with the gate removed,
 * the same queue feeds a publish that SUCCEEDS with `sha256: null` - the exact
 * shape of the two releases nobody could install.
 */
function queuePublishReads(filename = INSTALLER, checksum: string | null = DIGEST) {
  rows.push([{ id: "up1", published: true, passwordHash: null, filename, checksum }]);
  rows.push([
    {
      code: "rel123",
      ext: "exe",
      filename,
      size: PAYLOAD.length,
      checksum,
      published: true,
      ownerId: ACCOUNT.id,
      expiresAt: null,
      passwordHash: null,
    },
  ]);
  rows.push([{ userCode: ACCOUNT.userCode, preferredDomain: null, skipTag: false }]);
}

function sourceFile(name: string, bytes: Buffer = PAYLOAD): string {
  const path = join(SRC_DIR, name);
  writeFileSync(path, bytes);
  return path;
}

function stagedFiles(): string[] {
  return existsSync(STAGE_DIR) ? readdirSync(STAGE_DIR) : [];
}

/* -------------------------------------------------------------------------- */
/* Driving the script                                                          */
/* -------------------------------------------------------------------------- */

interface Run {
  code: number;
  out: string;
  err: string;
}

/**
 * Run scripts/publish-release.ts the way a shell would.
 *
 * The module calls `main()` on evaluation and hands the result to
 * `process.exit`, so the import resolves while the work is still in flight -
 * hence the stubbed exit and the wait for it. Importing the real script rather
 * than a copy of its logic is the whole point: the refusal being tested is
 * worth nothing if the script can still reach `publishRelease` around it.
 */
async function run(argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));

  let exitCode: number | null = null;
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    return undefined as never;
  }) as never);

  const argvBefore = process.argv;
  process.argv = ["node", "publish-release", ...argv];

  try {
    vi.resetModules();
    await import("@/scripts/publish-release");
    for (let i = 0; i < 600 && exitCode === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    process.argv = argvBefore;
    exit.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }

  if (exitCode === null) throw new Error("publish-release never exited");
  return { code: exitCode, out: out.join("\n"), err: err.join("\n") };
}

beforeEach(() => {
  rows.length = 0;
  settings.clear();
  finalizeMock.mockReset();
  finalizeMock.mockResolvedValue({
    id: "up1",
    code: "rel123",
    ext: "exe",
    storageKey: "alicja/rel123.exe",
    url: "https://host.example.com/alicja/rel123.exe",
    rawUrl: "https://host.example.com/alicja/rel123/raw.exe",
    copyUrl: "https://host.example.com/alicja/rel123.exe",
    deletionUrl: "https://host.example.com/alicja/rel123/delete/tok",
    folderId: null,
  });
  rmSync(STAGE_DIR, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(STAGE_DIR, { recursive: true, force: true });
  rmSync(SRC_DIR, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

describe("isReleaseDigest", () => {
  it("accepts exactly what uploads.checksum stores", () => {
    expect(isReleaseDigest(DIGEST)).toBe(true);
  });

  for (const bad of [
    null,
    undefined,
    "",
    DIGEST.toUpperCase(),
    DIGEST.slice(0, 63),
    `${DIGEST}0`,
    "z".repeat(64),
  ]) {
    it(`refuses ${JSON.stringify(bad)?.slice(0, 20) ?? String(bad)}`, () => {
      expect(isReleaseDigest(bad)).toBe(false);
    });
  }
});

describe("publishVerifiedRelease", () => {
  it("refuses a row whose checksum is NULL, and writes nothing", async () => {
    rows.push([{ checksum: null }]);

    const result = await publishVerifiedRelease({
      version: "0.7.2",
      code: "rel123",
      expectedDigest: DIGEST,
    });

    expect(result).toEqual({ ok: false, reason: "no-digest" });
    expect(settings.get("release_app")).toBeUndefined();
  });

  it("refuses before it even looks the code up when the caller has no digest", async () => {
    const result = await publishVerifiedRelease({
      version: "0.7.2",
      code: "rel123",
      expectedDigest: "",
    });

    expect(result).toEqual({ ok: false, reason: "no-digest" });
    // Nothing was consumed: a caller with nothing to compare cannot even learn
    // whether the code exists.
    expect(rows.length).toBe(0);
  });

  it("refuses when the stored digest belongs to different bytes", async () => {
    const other = "a".repeat(64);
    rows.push([{ checksum: other }]);

    const result = await publishVerifiedRelease({
      version: "0.7.2",
      code: "rel123",
      expectedDigest: DIGEST,
    });

    expect(result).toEqual({
      ok: false,
      reason: "digest-mismatch",
      stored: other,
      expected: DIGEST,
    });
    expect(settings.get("release_app")).toBeUndefined();
  });

  it("publishes when the row carries the digest, and the manifest promises it", async () => {
    rows.push([{ checksum: DIGEST }]);
    queuePublishReads();

    const result = await publishVerifiedRelease({
      version: "0.7.2",
      code: "rel123",
      expectedDigest: DIGEST,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.sha256).toBe(DIGEST);
    expect(result.manifest.filename).toBe(INSTALLER);
  });
});

describe("releaseFileName", () => {
  it("defaults to the basename of the path it was given", () => {
    expect(releaseFileName(`/tmp/${INSTALLER}`)).toBe(INSTALLER);
    expect(releaseFileName(`C:\\builds\\${INSTALLER}`)).toBe(INSTALLER);
  });

  it("lets an override win, because the staged copy is often called rel.exe", () => {
    expect(releaseFileName("/tmp/rel.exe", INSTALLER)).toBe(INSTALLER);
  });

  it("strips separators off an override rather than storing a path", () => {
    expect(releaseFileName("/tmp/rel.exe", `dist/${INSTALLER}`)).toBe(INSTALLER);
  });

  for (const bad of ["", "   ", "/", ".", "..", `bad\nname.exe`, `${"n".repeat(256)}.exe`]) {
    it(`refuses ${JSON.stringify(bad)} rather than inventing a name`, () => {
      expect(releaseFileName("/tmp/rel.exe", bad)).toBeNull();
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The script                                                                  */
/* -------------------------------------------------------------------------- */

describe("scripts/publish-release", () => {
  it("hashes the file, stores the digest on the row, and prints it", async () => {
    const file = sourceFile(INSTALLER);
    rows.push([ACCOUNT]);
    rows.push([{ checksum: DIGEST }]);
    queuePublishReads();

    const result = await run([
      "--file",
      file,
      "--version",
      "0.7.2",
      "--owner",
      ACCOUNT.email,
      "--apply",
    ]);

    expect(result.err).toBe("");
    expect(result.code).toBe(0);

    // The digest reaches the row: this is the line whose absence published two
    // releases nobody could install.
    const input = finalizeMock.mock.calls[0][0] as { checksum: string; filename: string; size: number; head: Buffer };
    expect(input.checksum).toBe(DIGEST);
    expect(input.size).toBe(PAYLOAD.length);
    expect(input.head.subarray(0, 2).toString()).toBe("MZ");

    // And a human can compare it against the build machine without a query.
    expect(result.out).toContain(DIGEST);
    expect(settings.get("release_app")).toContain('"version":"0.7.2"');
  });

  it("publishes the real file name, not the name of the staged copy", async () => {
    const file = sourceFile("rel.exe");
    rows.push([ACCOUNT]);
    rows.push([{ checksum: DIGEST }]);
    queuePublishReads();

    const result = await run([
      "--file",
      file,
      "--name",
      INSTALLER,
      "--version",
      "0.7.2",
      "--owner",
      ACCOUNT.email,
      "--apply",
    ]);

    expect(result.code).toBe(0);
    const input = finalizeMock.mock.calls[0][0] as { filename: string; localPath: string };
    expect(input.filename).toBe(INSTALLER);
    // Ingested from a copy in the app's own scratch dir, never from --file: the
    // ingest is a move, and /tmp is a different device from /app/data.
    expect(input.localPath).not.toBe(file);
    expect(input.localPath.replace(/\\/g, "/")).toContain(STAGE_DIR);
  });

  it("cannot produce a manifest without a digest: a row with no checksum stops the publish", async () => {
    const file = sourceFile(INSTALLER);
    rows.push([ACCOUNT]);
    // What the two broken releases actually looked like in the database - and
    // queued so that a run WITHOUT the digest gate reaches `ok: true` with
    // `sha256: null`. Otherwise this test would pass against the old code.
    queuePublishReads(INSTALLER, null);

    const result = await run([
      "--file",
      file,
      "--version",
      "0.7.2",
      "--owner",
      ACCOUNT.email,
      "--apply",
    ]);

    expect(result.code).toBe(1);
    // The pointer never moved, so the channel still serves the previous, working
    // release rather than one no updater will accept.
    expect(settings.get("release_app")).toBeUndefined();
    expect(result.err).toContain("NIE OPUBLIKOWANE");
  });

  it("leaves the operator's build where it was, and cleans its own copy up", async () => {
    const file = sourceFile(INSTALLER);
    rows.push([ACCOUNT]);
    rows.push([{ checksum: DIGEST }]);
    queuePublishReads();

    await run(["--file", file, "--version", "0.7.2", "--owner", ACCOUNT.email, "--apply"]);

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file)).toEqual(PAYLOAD);
    // finalizeUpload is faked here, so nothing moved the staged copy away; the
    // script's own cleanup is what has to remove it.
    expect(stagedFiles()).toEqual([]);
  });

  it("a dry run hashes the file and writes nothing at all", async () => {
    const file = sourceFile(INSTALLER);
    rows.push([ACCOUNT]);

    const result = await run(["--file", file, "--version", "0.7.2", "--owner", ACCOUNT.email]);

    expect(result.code).toBe(0);
    expect(result.out).toContain(DIGEST);
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(settings.get("release_app")).toBeUndefined();
    expect(stagedFiles()).toEqual([]);
  });

  it("catches a name-versus-version disagreement BEFORE it uploads anything", async () => {
    const file = sourceFile("rel.exe");
    rows.push([ACCOUNT]);

    const result = await run([
      "--file",
      file,
      "--name",
      "Modlight-0.7.1-setup-x64.exe",
      "--version",
      "0.7.2",
      "--owner",
      ACCOUNT.email,
      "--apply",
    ]);

    expect(result.code).toBe(2);
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(stagedFiles()).toEqual([]);
  });

  it("refuses a version no installed client could parse", async () => {
    const file = sourceFile(INSTALLER);

    const result = await run([
      "--file",
      file,
      "--version",
      "8",
      "--owner",
      ACCOUNT.email,
      "--apply",
    ]);

    expect(result.code).toBe(2);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("names both directories when the ingest itself fails", async () => {
    // What a cross-device move looks like from here: the bytes are staged, the
    // rename into storage refuses, and the errno alone explains nothing.
    const file = sourceFile(INSTALLER);
    rows.push([ACCOUNT]);
    finalizeMock.mockRejectedValue(
      Object.assign(new Error("ENOTDIR: not a directory, rename"), { code: "ENOTDIR" }),
    );

    const result = await run([
      "--file",
      file,
      "--version",
      "0.7.2",
      "--owner",
      ACCOUNT.email,
      "--apply",
    ]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("Kopia robocza");
    expect(result.err).toContain("UPLOAD_TMP_PATH");
    expect(settings.get("release_app")).toBeUndefined();
    expect(stagedFiles()).toEqual([]);
  });

  it("refuses a file it cannot read", async () => {
    const result = await run([
      "--file",
      join(SRC_DIR, "does-not-exist.exe"),
      "--version",
      "0.7.2",
      "--owner",
      ACCOUNT.email,
      "--apply",
    ]);

    expect(result.code).toBe(2);
    expect(finalizeMock).not.toHaveBeenCalled();
  });
});
