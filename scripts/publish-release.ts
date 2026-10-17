/**
 * Put a built installer on the site and make it THE download, in one step.
 *
 * Why this exists as a script rather than a click: the release channel is one
 * settings row naming an ordinary upload, so publishing needs (a) the file to
 * become an upload and (b) the pointer to move. The panel can do both from the
 * admin screen, but only with a person in front of it - and a release cut from a
 * build machine should not require anybody to paste a credential into a form.
 *
 * It ingests through `finalizeUpload`, the same function the ShareX endpoint
 * uses, so the file gets the account's quota accounting, the real MIME sniff and
 * the storage driver - rather than a second, subtly different path that would
 * drift from the real one.
 *
 * THREE THINGS THIS SCRIPT GOT WRONG, AND WHY IT NOW LOOKS LIKE THIS
 *
 *  1. It never computed a checksum. `finalizeUpload` stores the sha256 its
 *     CALLER hands it: the ShareX path has one because the bytes stream through
 *     a hash on their way to disk, and this script simply never produced one. So
 *     `uploads.checksum` stayed NULL, the manifest promised `sha256: null`, and
 *     the desktop updater refuses an update carrying no digest (fail-closed, and
 *     correctly so). Two releases in a row went out that no installed copy would
 *     ever accept, and both digests had to be patched in by hand afterwards.
 *     The file is now read through a hash before anything is written, and
 *     `publishVerifiedRelease` refuses to move the pointer unless the row really
 *     carries the digest this script computed.
 *
 *  2. It published under whatever `--file` happened to be called. A build staged
 *     at /tmp/rel.exe became a release named `rel.exe`, which is not merely ugly:
 *     `versionFromFileName` is the one free second opinion on the typed version
 *     number, and a temp name silences it. The name now comes from the basename
 *     of --file (or --name), and the name-versus-version check runs BEFORE the
 *     upload instead of after it, so a typo costs nothing.
 *
 *  3. It handed `--file` straight to `finalizeUpload`, which MOVES it. Inside
 *     the container /tmp is a different device from /app/data, so that move
 *     failed on a temp path - and when it did not fail it consumed the
 *     operator's only copy of the build. The bytes are now copied into the app's
 *     own scratch directory (the one the ShareX path stages into, which is on
 *     the storage filesystem by construction), so the ingest is a rename and the
 *     source file is left alone wherever it lives.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write anything. A dry run still reads and
 * hashes the file, so the digest can be compared against the build machine's
 * before anybody commits to publishing.
 *
 *   node dist/scripts/publish-release.js \
 *     --file /tmp/Modlight-0.7.2-setup-x64.exe --version 0.7.2 \
 *     --owner admin@example.com [--name ...] [--notes "..."] [--force] [--apply]
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as users } from "@/lib/db/schema";
import { config } from "@/lib/config";
import { hasRoomFor, sameFilesystem } from "@/lib/upload/disk";
import { finalizeUpload, type FinalizeResult } from "@/lib/upload/finalize";
import {
  APP_NAME,
  currentRelease,
  isReleaseDigest,
  normalizeReleaseVersion,
  publishVerifiedRelease,
  releaseFileName,
  sameReleaseVersion,
  versionFromFileName,
  type VerifiedPublishResult,
} from "@/lib/releases-core";

/** What `finalizeUpload` reads to decide what the file actually is. */
const HEAD_BYTES = 4096;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const USAGE =
  "usage: --file <path> --version <x.y.z> --owner <email|tag> [--name <filename>] [--notes ...] [--force] [--apply]";

interface Scan {
  /** sha256 of every byte that went past, lower-case hex. */
  digest: string;
  /** Bytes actually read, so the digest and the recorded size describe one file. */
  size: number;
  /** First bytes, for the MIME sniff, taken from the same pass. */
  head: Buffer;
}

/**
 * Read the build exactly once: hash it, keep its first bytes, and - when
 * publishing - drop a copy at `stagePath` on the way through.
 *
 * One pass rather than "hash it, then copy it" because a release is ~80 MB and
 * the two reads could disagree: a build machine that rewrites the file between
 * them would produce a digest belonging to bytes nobody ever uploaded, which is
 * precisely the lie the manifest must never tell.
 *
 * `stagePath` null is the dry run: the same read, nothing written.
 */
async function scanSource(source: string, stagePath: string | null): Promise<Scan> {
  const hash = createHash("sha256");
  const head: Buffer[] = [];
  let headBytes = 0;
  let size = 0;

  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      if (headBytes < HEAD_BYTES) {
        const take = chunk.subarray(0, HEAD_BYTES - headBytes);
        head.push(Buffer.from(take));
        headBytes += take.length;
      }
      cb(null, chunk);
    },
  });

  const sink = stagePath
    ? createWriteStream(stagePath)
    : new Writable({
        write(_chunk, _enc, cb) {
          cb();
        },
      });

  await pipeline(createReadStream(source), tap, sink);
  return { digest: hash.digest("hex"), size, head: Buffer.concat(head) };
}

/** Why the pointer did not move, in a sentence somebody can act on. */
function refusalText(result: Extract<VerifiedPublishResult, { ok: false }>): string {
  switch (result.reason) {
    case "no-version":
      return "pusta wersja albo pusty kod pliku";
    case "bad-version":
      return "wersji nie odczyta zaden zainstalowany klient (potrzebne Major.Minor)";
    case "not-found":
      return "nie ma takiego pliku";
    case "not-public":
      return "plik nie jest opublikowany albo ma haslo";
    case "version-mismatch":
      return `nazwa pliku mowi ${result.fileVersion}, a wersja to co innego (${result.filename}); dodaj --force jesli tak ma byc`;
    case "no-digest":
      return "wiersz pliku nie ma sumy kontrolnej - updater odmowilby takiej aktualizacji";
    case "digest-mismatch":
      return `w bazie jest inna suma (${result.stored}) niz policzona z pliku (${result.expected})`;
  }
}

async function main(): Promise<number> {
  const file = arg("file");
  const rawVersion = arg("version");
  const owner = arg("owner");
  const notes = arg("notes");
  const apply = has("apply");
  const force = has("force");

  if (!file || !rawVersion || !owner) {
    console.error(USAGE);
    return 2;
  }

  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    console.error(`nie ma pliku: ${file}`);
    return 2;
  }

  // The name the release is published under. `finalizeUpload` records whatever
  // name it is handed, so handing it the staging path is how a release ends up
  // called "rel.exe".
  const nameOverride = arg("name");
  const filename = releaseFileName(file, nameOverride);
  if (!filename) {
    console.error(`nie da sie zrobic nazwy pliku z: ${nameOverride ?? file}`);
    return 2;
  }

  const version = normalizeReleaseVersion(rawVersion);
  if (!version) {
    console.error(
      `wersji "${rawVersion}" nie odczyta zaden zainstalowany klient - System.Version chce co najmniej Major.Minor, same cyfry i kropki`,
    );
    return 2;
  }

  // Name versus version, BEFORE anything is uploaded. `publishRelease` runs the
  // same comparison at the end, but a refusal there leaves a stray upload on the
  // account that somebody then has to find and delete.
  const fileVersion = versionFromFileName(filename);
  const mismatch = fileVersion !== null && !sameReleaseVersion(fileVersion, version);
  if (mismatch && !force) {
    console.error(
      `nazwa pliku mowi ${fileVersion}, a --version to ${version} (${filename}). Dodaj --force jesli tak ma byc.`,
    );
    return 2;
  }

  // Resolved by email OR tag, because whoever cuts a release knows one of them
  // and should not have to look up an internal id.
  const [account] = await db
    .select()
    .from(users)
    .where(or(eq(users.email, owner), eq(users.userCode, owner)))
    .limit(1);
  if (!account) {
    console.error(`nie ma konta: ${owner}`);
    return 2;
  }

  console.log(`${APP_NAME} ${version}`);
  console.log(`  zrodlo  : ${resolve(file)} (${info.size} B)`);
  console.log(`  nazwa   : ${filename}`);
  console.log(`  konto   : ${account.email} [${account.userCode}]`);
  console.log(`  tryb    : ${apply ? "ZAPIS" : "proba na sucho"}`);
  if (mismatch) console.log(`  uwaga   : nazwa mowi ${fileVersion}, publikuje mimo to (--force)`);

  const before = await currentRelease();
  console.log(`  obecne  : ${before ? `${before.version} (${before.filename})` : "brak"}`);

  // Staged into the app's own scratch dir rather than ingested from --file: the
  // ingest is a move, so a temp path on another device fails and a path the
  // operator cares about gets eaten. This directory is on the storage
  // filesystem by construction (server.ts creates it next to data/storage), so
  // the move is a rename and costs nothing.
  const stageDir = resolve(config.uploads.tmpPath);
  const storageRoot = resolve(config.storage.localPath);
  const stagePath = join(stageDir, `release-${randomUUID()}`);

  if (apply) {
    if (!(await hasRoomFor(info.size, stageDir))) {
      console.error(`za malo miejsca na dysku, zeby odlozyc kopie w ${stageDir}`);
      return 1;
    }
    await mkdir(stageDir, { recursive: true });

    // Said out loud rather than assumed. This is the one setting that can put
    // the staging copy back on another device - which is where the ingest broke
    // in the first place - and it is invisible from the command line.
    if (config.storage.driver === "local" && !(await sameFilesystem(stageDir, storageRoot))) {
      console.log(`  uwaga   : ${stageDir} i ${storageRoot} to rozne systemy plikow`);
      console.log("            (ustaw UPLOAD_TMP_PATH na katalog obok magazynu)");
    }
  }

  let scan: Scan;
  try {
    scan = await scanSource(file, apply ? stagePath : null);
  } catch (err) {
    if (apply) await rm(stagePath, { force: true }).catch(() => {});
    console.error(`nie udalo sie przeczytac pliku: ${(err as Error).message}`);
    console.error(`Plik musi byc czytelny dla procesu aplikacji, a ${stageDir} zapisywalny.`);
    return 1;
  }

  // Belt and braces: a digest that is not a digest must stop the run here,
  // before a single row is written. The updater treats a manifest with no sha256
  // as "do not install", so publishing one is worse than not publishing at all -
  // it looks like a release and is not one.
  if (!isReleaseDigest(scan.digest)) {
    if (apply) await rm(stagePath, { force: true }).catch(() => {});
    console.error("nie udalo sie policzyc sumy sha256 - nic nie zapisano");
    return 1;
  }

  console.log(`  sha256  : ${scan.digest}`);
  console.log(`  bajtow  : ${scan.size}`);

  if (!apply) {
    console.log("\nnic nie zapisano. dodaj --apply");
    return 0;
  }

  try {
    let result: FinalizeResult;
    try {
      // `folderId: null` - the root, not the account's default folder. A release
      // is infrastructure, and dropping it into whatever folder the owner happens
      // to upload screenshots into would put it in the way of their own files.
      //
      // The MIME is left to `resolveUploadType`, which reads the head we already
      // have: an installer starts with MZ and the extension table knows .exe, so
      // naming a type here would only be a chance to be wrong about a .zip or
      // .msi.
      result = await finalizeUpload({
        owner: account,
        filename,
        mime: "application/octet-stream",
        size: scan.size,
        localPath: stagePath,
        head: scan.head,
        checksum: scan.digest,
        folderId: null,
      });
    } catch (err) {
      // The ingest is a move, and a move is where a filesystem boundary shows up
      // as something unhelpful like ENOTDIR. Name both directories rather than
      // leaving an errno to be interpreted.
      console.error(`\nnie udalo sie wgrac pliku: ${(err as Error).message}`);
      if (config.storage.driver === "local") {
        console.error(`Kopia robocza: ${stageDir}`);
        console.error(`Magazyn      : ${storageRoot}`);
        console.error(
          "Jesli to dwa rozne systemy plikow, ustaw UPLOAD_TMP_PATH na katalog obok magazynu.",
        );
      }
      return 1;
    }

    console.log(`  wgrane  : ${result.url}`);

    // --force lets a release be cut from a hand-renamed installer; without it a
    // version that disagrees with the file name stops here, which is the point.
    const published = await publishVerifiedRelease({
      version,
      code: result.code,
      notes,
      allowVersionMismatch: force,
      expectedDigest: scan.digest,
    });
    if (!published.ok) {
      // The upload survives - it is a normal file and can be published by hand.
      console.error(`\nWGRANE, ALE NIE OPUBLIKOWANE: ${refusalText(published)}`);
      console.error("Plik jest na koncie; opublikuj go z panelu (Admin -> Konserwacja).");
      return 1;
    }

    console.log(`\nopublikowane: ${published.manifest.version}`);
    console.log(`  url    : ${published.manifest.url}`);
    console.log(`  plik   : ${published.manifest.filename}`);
    console.log(`  sha256 : ${published.manifest.sha256}`);
    console.log(`  rozmiar: ${published.manifest.size} B`);
    return 0;
  } finally {
    // A successful ingest already renamed it away; this is for every other exit.
    await rm(stagePath, { force: true }).catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
