import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What may be published as a version, and what the file name gets a say in.
 *
 * The bug this pins: `version` was free text with one check - not empty - while
 * the other half of the comparison it takes part in is compiled into the binary
 * (Directory.build.props -> AssemblyInformationalVersion -> Application.ProductVersion).
 * Publishing 0.7.1 for a build that installs as 0.7.0 does not fail; it succeeds
 * forever. Every installed copy updates, comes back reporting 0.7.0, is offered
 * 0.7.1 again at the next launch and every hour after that, and nothing anywhere
 * remembers a version it already declined. So the disagreement has to be caught
 * at the moment somebody can still fix it, which is here.
 */

const rows: Record<string, unknown>[][] = [];
const settings = new Map<string, string | null>();

/**
 * Just enough Drizzle to run the real function.
 *
 * The queries under test are single-table, single-row lookups, so what a fake
 * has to get right is the ORDER of the answers, not the WHERE clause - the
 * refusals this file is about all happen before the second query is reached.
 * Anything deeper (see tests/helpers/fake-db.ts) would be fake for its own sake.
 */
vi.mock("@/lib/db", () => {
  const chain = () => {
    const self: Record<string, unknown> = {};
    for (const method of ["from", "where", "limit", "orderBy"]) {
      self[method] = () => self;
    }
    self.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(resolve);
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

const { publishRelease, normalizeReleaseVersion, versionFromFileName } = await import(
  "@/lib/releases-core"
);

const INSTALLER = "Modlight-0.7.0-setup-x64.exe";

/** The upload row publishRelease looks at, and then the two currentRelease reads. */
function queueHappyPath(filename = INSTALLER) {
  rows.push([{ id: "up1", published: true, passwordHash: null, filename }]);
  rows.push([
    {
      code: "saluy6",
      ext: "exe",
      filename,
      size: 82317446,
      checksum: "77".repeat(32),
      published: true,
      ownerId: "admin",
      expiresAt: null,
      passwordHash: null,
    },
  ]);
  rows.push([{ userCode: "tag", preferredDomain: null, skipTag: false }]);
}

beforeEach(() => {
  rows.length = 0;
  settings.clear();
});

describe("normalizeReleaseVersion", () => {
  // System.Version needs at least Major.Minor, so a bare number is a version no
  // installed client can parse - and a channel published with one answers
  // CheckFailed forever while the panel reports a healthy release.
  for (const good of ["0.7", "0.7.0", "0.7.0.1", "v0.7.0", " 1.2.3 ", "10.20.30.40"]) {
    it(`accepts ${JSON.stringify(good)}`, () => {
      expect(normalizeReleaseVersion(good)).not.toBeNull();
    });
  }

  for (const bad of ["", "8", "0.7.1-beta", "0.7.1+build", "seven", "0.7.0.1.2", "0..7", "-1.0"]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(normalizeReleaseVersion(bad)).toBeNull();
    });
  }

  it("drops the v, because every client drops it before comparing", () => {
    expect(normalizeReleaseVersion("v0.7.0")).toBe("0.7.0");
  });
});

describe("versionFromFileName", () => {
  it("reads the version Inno wrote into the name", () => {
    expect(versionFromFileName(INSTALLER)).toBe("0.7.0");
  });

  it("is not fooled by the architecture suffix", () => {
    expect(versionFromFileName("Modlight-1.2.3.4-setup-x64.exe")).toBe("1.2.3.4");
  });

  it("says nothing when the name carries no version", () => {
    expect(versionFromFileName("Modlight-setup.exe")).toBeNull();
    expect(versionFromFileName("installer.exe")).toBeNull();
  });
});

describe("publishRelease", () => {
  it("refuses a version no client could parse, before touching the database", async () => {
    const result = await publishRelease({ version: "0.7.1-beta", code: "saluy6" });
    expect(result).toEqual({ ok: false, reason: "bad-version" });
    expect(rows.length).toBe(0);
    expect(settings.get("release_app")).toBeUndefined();
  });

  it("still refuses an empty version the old way", async () => {
    expect(await publishRelease({ version: "  ", code: "saluy6" })).toEqual({
      ok: false,
      reason: "no-version",
    });
  });

  it("refuses a version the installer's own name contradicts, and writes nothing", async () => {
    rows.push([{ id: "up1", published: true, passwordHash: null, filename: INSTALLER }]);

    const result = await publishRelease({ version: "0.7.1", code: "saluy6" });

    expect(result).toEqual({
      ok: false,
      reason: "version-mismatch",
      fileVersion: "0.7.0",
      filename: INSTALLER,
    });
    expect(settings.get("release_app")).toBeUndefined();
  });

  it("publishes the same mismatch once it is explicitly confirmed", async () => {
    queueHappyPath();

    const result = await publishRelease({
      version: "0.7.1",
      code: "saluy6",
      allowVersionMismatch: true,
    });

    expect(result.ok).toBe(true);
    expect(settings.get("release_app")).toContain('"version":"0.7.1"');
  });

  it("treats 0.7 and 0.7.0.0 as one version rather than a disagreement", async () => {
    queueHappyPath("Modlight-0.7-setup-x64.exe");

    const result = await publishRelease({ version: "0.7.0.0", code: "saluy6" });

    expect(result.ok).toBe(true);
  });

  it("says nothing about the name when the name says nothing", async () => {
    queueHappyPath("Modlight-setup.exe");

    const result = await publishRelease({ version: "0.7.0", code: "saluy6" });

    expect(result.ok).toBe(true);
  });

  it("stores the version without its v, so the manifest matches what clients compare", async () => {
    queueHappyPath();

    const result = await publishRelease({ version: "v0.7.0", code: "saluy6" });

    expect(result.ok).toBe(true);
    expect(settings.get("release_app")).toContain('"version":"0.7.0"');
  });
});
