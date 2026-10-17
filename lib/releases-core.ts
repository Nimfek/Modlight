/**
 * The release channel, without the `server-only` guard.
 *
 * Split from lib/releases.ts for one concrete reason: scripts/publish-release.ts
 * is bundled by esbuild with `--packages=external`, and `server-only` is not an
 * installed package - it resolves only inside Next's bundler. A script that
 * imported it would emit a specifier Node cannot resolve, and
 * scripts/check-server-bundle.mjs refuses the build for exactly that. Same shape
 * as lib/folders.ts and lib/uploads.ts: the rules live here, the guarded module
 * is a shim over them.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users } from "@/lib/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { rawUrl, taglessRawUrl, userBaseUrl } from "@/lib/media/urls";

/**
 * Published builds of the companion app.
 *
 * The binary is NOT a new kind of object: it is an ordinary upload in an
 * administrator's library, and this module only records WHICH upload is the
 * current release. Everything a download needs — streaming, Range requests,
 * ETags, the storage driver, the quota it occupies — therefore already works,
 * and a release channel costs one settings row instead of a subsystem.
 *
 * The integrity hash is not computed here either. `uploads.checksum` is the
 * sha256 the upload path already calculated while the bytes streamed past, so
 * the manifest can promise it for free — which happens to be exactly what the
 * companion's updater verifies before it swaps a binary in.
 */

/** What the settings row stores. Deliberately small: a pointer plus prose. */
interface StoredRelease {
  version: string;
  /** `uploads.code` of the binary. The row is the source of truth for size/hash. */
  code: string;
  notes?: string;
  publishedAt: string;
}

/** What a client (or the download page) is told. */
export interface ReleaseManifest {
  name: string;
  version: string;
  /** Absolute URL of the binary itself. */
  url: string;
  filename: string;
  size: number;
  /** sha256, lower-case hex. Null only for files uploaded before checksums. */
  sha256: string | null;
  notes: string | null;
  publishedAt: string;
}

export const APP_NAME = "Modlight App";

/**
 * A version string, split into numbers, by the desktop app's own rules.
 *
 * Deliberately a re-statement of `ModlightRelease.TryParseVersion` in the
 * client: a leading `v` is allowed, everything else must be digits and dots,
 * and `System.Version` needs at least `Major.Minor` — so the plain "8" that
 * looks perfectly reasonable in a form is a version NO installed copy can read,
 * and a channel published with it answers `CheckFailed` forever while the panel
 * cheerfully reports a release.
 */
function parseVersion(raw: string): number[] | null {
  let value = raw.trim();
  if (value.startsWith("v") || value.startsWith("V")) value = value.slice(1);
  if (!/^\d+(\.\d+){1,3}$/.test(value)) return null;

  const parts = value.split(".").map((part) => Number(part));
  // Each component of System.Version is an Int32 and must be non-negative.
  if (parts.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 2147483647)) return null;
  return parts;
}

/** The same version in one comparable shape, so 1.2, 1.2.0 and 1.2.0.0 are one thing. */
function versionKey(raw: string): string | null {
  const parts = parseVersion(raw);
  if (!parts) return null;
  while (parts.length < 4) parts.push(0);
  return parts.join(".");
}

/**
 * The version as it will be stored and shown, or null if no client could read it.
 *
 * The `v` is dropped rather than kept: every installed copy strips it before
 * comparing, so keeping it would leave the manifest saying one thing and every
 * updater on earth acting on another.
 */
export function normalizeReleaseVersion(raw: string): string | null {
  if (!parseVersion(raw)) return null;
  const value = raw.trim();
  return value.startsWith("v") || value.startsWith("V") ? value.slice(1) : value;
}

/**
 * The version the installer's own file name claims, or null when it claims none.
 *
 * This is the only fact about the binary that is free. Inno writes the name from
 * `OutputBaseFilename={#MyAppName}-{#MyAppVersion}-setup-{#Platform}`, and
 * `{#MyAppVersion}` is read out of the built exe's ProductVersion — so the name
 * carries the number that the app will report about itself after installing.
 * Which is exactly the number the typed field has to agree with, and the reason
 * a typo there is not cosmetic: the app compares what it IS against what the
 * channel OFFERS, so an offer of 0.7.1 backed by a 0.7.0 binary is an update
 * that installs and then asks to be installed again, at every launch and every
 * hour after that, with nothing anywhere that ever says "you already have this".
 */
export function versionFromFileName(filename: string): string | null {
  const base = filename.replace(/\.[^.]*$/, "");

  for (const token of base.split(/[-_\s]+/)) {
    const normalized = normalizeReleaseVersion(token);
    if (normalized) return normalized;
  }

  return null;
}

/**
 * Two version strings that mean the same thing to an installed client.
 *
 * `System.Version` pads whatever it is not told, so 0.7, 0.7.0 and 0.7.0.0 are
 * one version while string comparison calls them three. Exported because the
 * publish script runs the same name-versus-version check BEFORE it uploads
 * anything, and a second spelling of this comparison would eventually disagree
 * with this one.
 */
export function sameReleaseVersion(a: string, b: string): boolean {
  const left = versionKey(a);
  return left !== null && left === versionKey(b);
}

/**
 * A sha256 in exactly the shape `uploads.checksum` stores and the manifest
 * promises: 64 lower-case hex characters.
 *
 * Not a formatting nicety. The desktop updater refuses an update whose manifest
 * carries no digest (fail-closed, and correctly so), so "there is a digest" is
 * the difference between a release that installs itself everywhere and one that
 * no installed copy will ever accept - which is what two published releases
 * turned out to be.
 */
export function isReleaseDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * The name a release is published under.
 *
 * `finalizeUpload` records whatever name the caller hands it, so a caller that
 * hands over the path it happened to stage the build at publishes a release
 * called `rel.exe`. That is not only ugly on the download page:
 * `versionFromFileName` is the one free second opinion on the typed version
 * number, and a temp name silences it, so the mistyped-version failure this
 * module goes to some length to catch simply stops being catchable.
 *
 * Returns null when nothing usable survives, so the caller refuses instead of
 * inventing a name.
 */
export function releaseFileName(sourcePath: string, override?: string): string | null {
  const raw = (override ?? sourcePath).trim();
  if (!raw) return null;

  // Separators are stripped rather than rejected: the default IS a path, and an
  // override typed with one is a slip rather than an attack. It still leaves
  // here as a bare name, because it ends up in a database column and in a
  // Content-Disposition header.
  const name = raw.split(/[\\/]/).filter(Boolean).pop() ?? "";
  if (!name || name === "." || name === "..") return null;
  // Control characters would travel into that header; nothing legitimate has them.
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name.length > 255 ? null : name;
}

function parse(raw: string | null): StoredRelease | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredRelease>;
    if (typeof value.version !== "string" || typeof value.code !== "string") return null;
    if (!value.version || !value.code) return null;
    return {
      version: value.version,
      code: value.code,
      notes: typeof value.notes === "string" ? value.notes : undefined,
      publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * The current release, resolved against the upload it names.
 *
 * Returns null when nothing is published OR when the file behind it is gone
 * (deleted, trashed, or its account removed). That second case matters: a
 * manifest naming a file that 404s would send every installed copy of the app
 * into a failed-update loop, so "the pointer is dangling" has to read as "there
 * is no release", not as a release with a broken link.
 */
export async function currentRelease(): Promise<ReleaseManifest | null> {
  const stored = parse(await getSetting("release_app"));
  if (!stored) return null;

  const [row] = await db
    .select({
      code: uploads.code,
      ext: uploads.ext,
      filename: uploads.filename,
      size: uploads.size,
      checksum: uploads.checksum,
      published: uploads.published,
      ownerId: uploads.ownerId,
      expiresAt: uploads.expiresAt,
      passwordHash: uploads.passwordHash,
    })
    .from(uploads)
    .where(and(eq(uploads.code, stored.code), isNull(uploads.deletedAt)))
    .limit(1);

  if (!row || !row.ownerId) return null;
  // A release has to be fetchable by a machine with no session and no password.
  if (!row.published || row.passwordHash || row.expiresAt) return null;

  const [owner] = await db
    .select({ userCode: users.userCode, preferredDomain: users.preferredDomain, skipTag: users.skipTagInUrl })
    .from(users)
    .where(eq(users.id, row.ownerId))
    .limit(1);
  if (!owner) return null;

  const base = userBaseUrl(owner.preferredDomain ?? null);
  const tag = owner.userCode ?? "u";
  const url = owner.skipTag
    ? taglessRawUrl(row.code, row.ext, base)
    : rawUrl(tag, row.code, row.ext, base);

  return {
    name: APP_NAME,
    version: stored.version,
    url,
    filename: row.filename,
    size: Number(row.size),
    sha256: row.checksum ?? null,
    notes: stored.notes ?? null,
    publishedAt: stored.publishedAt,
  };
}

export type PublishResult =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; reason: "no-version" | "bad-version" | "not-found" | "not-public" }
  | { ok: false; reason: "version-mismatch"; fileVersion: string; filename: string };

/**
 * Point the release channel at an upload.
 *
 * Validated eagerly rather than at download time: an administrator who mistypes
 * a code should hear about it while they are looking at the form, not when the
 * first user's updater fails at three in the morning. That sentence was already
 * here and applied only to `code`; the version field, the other half of the same
 * form, was free text with a single check that it was not empty.
 *
 * It is not free text. It is one half of a comparison whose other half is
 * compiled into the binary (`Directory.build.props` -> `AssemblyInformationalVersion`
 * -> `Application.ProductVersion`), and the app decides whether to offer an
 * update by comparing the two. Offering 0.7.1 for a binary that installs as
 * 0.7.0 therefore does not fail loudly: it succeeds, forever. The update window
 * comes back at every launch and every hour after that, "No" only lasts until
 * the process ends, and nothing in the app remembers a version it was already
 * offered. So the typo is caught here, where somebody can still fix it.
 */
export async function publishRelease(input: {
  version: string;
  code: string;
  notes?: string;
  /**
   * Publish even when the file name disagrees with the version.
   *
   * There are honest reasons for a disagreement — a hand-renamed file, an
   * installer whose name carries no version at all — so this is a confirmation
   * rather than a wall. It has to be asked for explicitly, once, per publish.
   */
  allowVersionMismatch?: boolean;
}): Promise<PublishResult> {
  const raw = input.version.trim();
  const code = input.code.trim();
  if (!raw || !code) return { ok: false, reason: "no-version" };

  const version = normalizeReleaseVersion(raw);
  if (!version) return { ok: false, reason: "bad-version" };

  const [row] = await db
    .select({
      id: uploads.id,
      published: uploads.published,
      passwordHash: uploads.passwordHash,
      filename: uploads.filename,
    })
    .from(uploads)
    .where(and(eq(uploads.code, code), isNull(uploads.deletedAt)))
    .limit(1);
  if (!row) return { ok: false, reason: "not-found" };
  if (!row.published || row.passwordHash) return { ok: false, reason: "not-public" };

  // The binary's own name is the cheapest second opinion available, and the
  // live manifest carries one: Modlight-0.7.0-setup-x64.exe. Compared on the
  // numbers, so 0.7 and 0.7.0.0 do not read as a disagreement.
  const fileVersion = versionFromFileName(row.filename);
  if (fileVersion && !input.allowVersionMismatch && !sameReleaseVersion(fileVersion, version)) {
    return { ok: false, reason: "version-mismatch", fileVersion, filename: row.filename };
  }

  const stored: StoredRelease = {
    version,
    code,
    notes: input.notes?.trim() || undefined,
    publishedAt: new Date().toISOString(),
  };
  await setSetting("release_app", JSON.stringify(stored));

  const manifest = await currentRelease();
  // currentRelease re-reads and re-validates; if it says no, the write was
  // pointless and the caller must not be told it worked.
  if (!manifest) return { ok: false, reason: "not-public" };
  return { ok: true, manifest };
}

export type VerifiedPublishResult =
  | PublishResult
  | { ok: false; reason: "no-digest" }
  | { ok: false; reason: "digest-mismatch"; stored: string; expected: string };

/**
 * Publish, but only once the upload really carries the digest the publisher
 * hashed out of the bytes it handed over.
 *
 * `publishRelease` cannot ask this of itself. An administrator republishing a
 * file that predates checksums has a legitimate reason to move the pointer, and
 * the panel's own result union is closed, so a new refusal reason there would
 * break the form rather than the mistake. A script cutting a release has no such
 * excuse: it is holding the file, so it can hash it. Two releases went out of
 * that script with `sha256: null`, and every updater was right to refuse them.
 *
 * The gate runs BEFORE `publishRelease`, so a refusal here writes nothing at
 * all and the channel keeps pointing at the previous, working release.
 */
export async function publishVerifiedRelease(input: {
  version: string;
  code: string;
  notes?: string;
  allowVersionMismatch?: boolean;
  /** sha256 the caller computed from the bytes it handed to the upload path. */
  expectedDigest: string;
}): Promise<VerifiedPublishResult> {
  const code = input.code.trim();
  if (!input.version.trim() || !code) return { ok: false, reason: "no-version" };
  // Checked before the query, so a caller with nothing to compare cannot even
  // learn whether the code exists.
  if (!isReleaseDigest(input.expectedDigest)) return { ok: false, reason: "no-digest" };

  const [row] = await db
    .select({ checksum: uploads.checksum })
    .from(uploads)
    .where(and(eq(uploads.code, code), isNull(uploads.deletedAt)))
    .limit(1);
  if (!row) return { ok: false, reason: "not-found" };
  if (!isReleaseDigest(row.checksum)) return { ok: false, reason: "no-digest" };
  // Different bytes: the pointer would name a file this publisher never hashed,
  // and the manifest would promise a digest that belongs to something else.
  if (row.checksum !== input.expectedDigest) {
    return {
      ok: false,
      reason: "digest-mismatch",
      stored: row.checksum,
      expected: input.expectedDigest,
    };
  }

  return publishRelease(input);
}

/** Withdraw the current release, so the page and the manifest report none. */
export async function unpublishRelease(): Promise<void> {
  await setSetting("release_app", null);
}
