import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Server as TusServer, type Upload } from "@tus/server";
import { FileStore } from "@tus/file-store";
import { S3Store } from "@tus/s3-store";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { config } from "@/lib/config";
import { hasRoomFor } from "@/lib/upload/disk";
import { finalizeUpload, QuotaExceededError, OutOfSpaceError, remainingQuota, type QuotaHolder } from "@/lib/upload/finalize";
import {
  authenticateApiToken,
  bearerFromRequest,
  tokenRefusal,
  type UserRow,
} from "@/lib/api-token";
import {
  FOLDER_KEY,
  ROOT_FOLDER,
  resolveFolderFromMetadata,
} from "@/lib/upload/folder-target";

/**
 * How long an abandoned upload is kept before the sweeper reclaims it. Long
 * enough that "my laptop slept overnight" still resumes; short enough that a
 * half-sent 2 GB file doesn't squat on the disk forever.
 */
export const TUS_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/** How often server.ts runs the sweep. */
export const TUS_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Grace period before an orphaned record is reaped. See reapOrphanedRecords. */
const ORPHAN_GRACE_MS = 5 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Drop target                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Metadata key carrying the folder a web upload should land in.
 *
 * Mirrors `components/upload/protocol.ts` — that module cannot be imported here
 * (it lives under `components/` and this is a server module), so the two
 * literals are kept in step by hand.
 */
export const FOLDER_META_KEY = FOLDER_KEY;

/** Sentinel meaning "no folder", as opposed to an absent key ("use the default"). */
export const ROOT_FOLDER_META = ROOT_FOLDER;

/**
 * Resolve the folder a browser upload asked for.
 *
 * The check itself lives in lib/upload/folder-target.ts because the API upload
 * path asks exactly the same question about a multipart field, and an ownership
 * check that exists twice is one that will eventually be fixed once.
 */
const requestedFolder = resolveFolderFromMetadata;

/**
 * Move a freshly finalized upload into the folder the drop targeted.
 *
 * Runs after `finalizeUpload`, which has already filed the row under the
 * account default. Ownership is re-checked and also folded into the WHERE
 * clause, so the worst a race (folder deleted mid-upload) can do is leave the
 * file where it was — never fail an upload whose bytes are already safe.
 */
async function applyTargetFolder(
  ownerId: string,
  uploadId: string,
  metadata: Record<string, string | null> | undefined,
): Promise<void> {
  let target: string | null | undefined;
  try {
    target = await requestedFolder(ownerId, metadata);
  } catch {
    return; // vanished between create and finish; the default folder stands
  }
  if (target === undefined) return;

  await db
    .update(uploads)
    .set({ folderId: target, updatedAt: new Date() })
    .where(and(eq(uploads.id, uploadId), eq(uploads.ownerId, ownerId)));
}

/** Minimal shape of the bits of a tus datastore we poke at directly. */
interface TusStore {
  remove(id: string): Promise<void>;
  /** Present on FileStore only — the scratch directory holding payloads. */
  directory?: string;
  configstore?: { delete?(id: string): Promise<void> };
}

async function userById(id: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

type TusAuth = { ok: true; user: UserRow } | { ok: false; status: number; body: string };

/**
 * Who is uploading: an API token first, the browser session second.
 *
 * The session alone was enough while the only client was Uppy in a same-origin
 * page. It is not enough for the desktop companions, which have a token and no
 * cookie — and resumability is exactly what they need most, because they push
 * multi-gigabyte files over domestic links where a single POST that dies at 95%
 * has to start again from zero.
 *
 * A PRESENT but invalid token is a refusal, never a fall-through to the
 * session. Otherwise a stale token in a config file would silently authenticate
 * as whoever happened to be signed in in the same browser, and the upload would
 * land in the wrong account with nothing to explain it.
 *
 * Beyond creation nothing re-authenticates: possession of the upload URL minted
 * here IS the capability for the PATCHes that follow, which is how tus works
 * and why the per-chunk path stays cheap.
 *
 * SCOPE. Creating a resumable upload is an upload, so `upload` is what it needs
 * and all it needs — the same capability `POST /upload` asks for, so a ShareX
 * token and an app token are judged by the same rule whichever transport they
 * arrive on. Because nothing after creation re-authenticates, this is the one
 * point at which the scope can be settled at all.
 */
async function ownerFromRequest(req: { headers: Headers }): Promise<TusAuth> {
  const token = bearerFromRequest(req.headers);
  if (token) {
    const result = await authenticateApiToken(token, "upload");
    if (!result.ok) {
      const { status, body } = tokenRefusal(result, "Sign in or send a valid API token.");
      // tus answers with a plain-text body, not JSON, so the sentence carries
      // the whole explanation — including which scope this needed.
      return { ok: false, status, body: String(body.message ?? "Refused.") };
    }
    return { ok: true, user: result.user };
  }

  const session = await auth.api.getSession({ headers: req.headers });
  const user = session ? await userById(session.user.id) : null;
  if (!user) return { ok: false, status: 401, body: "Sign in or send a valid API token." };
  // A session is the account itself and carries no scope; only the ban applies.
  if (user.banned) return { ok: false, status: 401, body: "Account disabled." };
  return { ok: true, user };
}

function makeDatastore() {
  if (config.storage.driver === "s3") {
    return new S3Store({
      partSize: 64 * 1024 * 1024, // >=5MiB, <=5GiB
      expirationPeriodInMilliseconds: TUS_EXPIRATION_MS,
      s3ClientConfig: {
        bucket: process.env.S3_BUCKET!,
        region: process.env.S3_REGION || "auto",
        endpoint: process.env.S3_ENDPOINT || undefined,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID!,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
        },
      },
    });
  }
  return new FileStore({
    directory: config.uploads.tusTmpPath,
    expirationPeriodInMilliseconds: TUS_EXPIRATION_MS,
  });
}

/**
 * Translate "bytes this user may still store" into tus's maxSize convention,
 * where **0 means unlimited**. `hardMax` is the operator's global ceiling and
 * follows the same convention.
 *
 * A user who is exactly at their quota must not collapse to 0 (tus would read
 * that as "no limit"), so the floor is 1 byte — every real upload then trips
 * ERR_MAX_SIZE_EXCEEDED, which is the intended outcome.
 */
export function tusMaxSize(owner: QuotaHolder, hardMax: number): number {
  const left = remainingQuota(owner);
  if (left === null) return hardMax > 0 ? hardMax : 0;
  const capped = hardMax > 0 ? Math.min(left, hardMax) : left;
  return Math.max(capped, 1);
}

/**
 * tus resumable upload server for the WEB UI (Uppy). Authenticated by the
 * Better Auth session cookie (no token needed — same-origin browser). A dropped
 * connection resumes from the last confirmed offset instead of restarting.
 */
export function createTusServer(): TusServer {
  const datastore = makeDatastore();
  const hardMax = config.uploads.maxSize > 0 ? config.uploads.maxSize : 0;

  const server = new TusServer({
    path: "/api/files",
    datastore,
    respectForwardedHeaders: config.trustProxy,

    /**
     * Quota is enforced here as a cap on the *declared* length, not only at
     * finalize. Without a maxSize, tus falls back to MAX_SAFE_INTEGER for any
     * upload whose length it doesn't know, so a client could stream unbounded
     * bytes to disk before anyone looked at the quota.
     *
     * Only creation needs the lookup: PATCH derives its own ceiling from the
     * length that was already validated here, so skipping the session + DB
     * round-trip there keeps the per-chunk path cheap.
     */
    async maxSize(req) {
      if (req.method !== "POST") return hardMax;
      const result = await ownerFromRequest(req);
      if (!result.ok) return hardMax; // onUploadCreate refuses it anyway
      return tusMaxSize(result.user, hardMax);
    },

    // Authenticate + quota-gate BEFORE any bytes are stored.
    async onUploadCreate(req, upload) {
      const authResult = await ownerFromRequest(req);
      if (!authResult.ok) throw { status_code: authResult.status, body: authResult.body };
      const owner = authResult.user;

      // Refuse `Upload-Defer-Length: 1`. An unknown size cannot be quota-checked
      // and is exactly the hole maxSize above cannot plug.
      if (upload.size == null) {
        throw { status_code: 411, body: "Upload-Length is required." };
      }

      if (!quotaAllows(owner, upload.size)) {
        throw { status_code: 507, body: "Quota exceeded." };
      }

      // Room on the machine, checked here rather than at finalize.
      //
      // tus knows the full length from the creation request (Upload-Length), so
      // there is no excuse for taking a 50 GB file for an hour and only then
      // discovering the disk never had room for it — or, worse, filling the disk
      // on the way to finding out and taking every other application on the host
      // down with us. ShareX has had this check since day one; the panel did not.
      if (!(await hasRoomFor(upload.size, config.uploads.tusTmpPath))) {
        throw { status_code: 507, body: "Server is low on disk space; upload rejected." };
      }

      // Fail the drop before a single byte is stored if the folder it names is
      // not this user's. Doing it here rather than at finish also means the
      // browser learns immediately, while the file is still on the desk.
      try {
        await requestedFolder(owner.id, upload.metadata);
      } catch {
        throw { status_code: 403, body: "Folder not found." };
      }

      return { metadata: { ...upload.metadata, userId: owner.id } };
    },

    // v2: (req, upload) — finalize into our storage + DB.
    async onUploadFinish(_req, upload: Upload) {
      const userId = upload.metadata?.userId;
      if (!userId) throw { status_code: 401, body: "Missing user." };
      const owner = await userById(userId);
      if (!owner) throw { status_code: 401, body: "Missing user." };

      const filename = upload.metadata?.filename || upload.metadata?.name || "file";
      const mime = upload.metadata?.filetype || upload.metadata?.type || "application/octet-stream";
      const isLocal = upload.storage?.type === "file";

      try {
        const result = await finalizeUpload({
          owner,
          filename,
          mime,
          size: upload.size ?? upload.offset ?? 0,
          // FileStore -> local path; S3Store -> object already in the bucket.
          localPath: isLocal ? upload.storage?.path : undefined,
          existingKey: isLocal ? undefined : upload.storage?.path,
        });

        // Drag-and-drop semantics: a file dropped while a folder is open lands
        // in THAT folder. finalizeUpload has already filed it under the account
        // default, so this only runs when the client named a target.
        await applyTargetFolder(owner.id, result.id, upload.metadata);

        // The bytes now live in our storage (finalize MOVED the temp file), but
        // FileStore still holds a sidecar .json describing a finished upload.
        // deleteExpired() only ever collects *unfinished* ones, so without this
        // they pile up forever. Skipped for S3, where remove() would delete the
        // very object we just adopted.
        if (isLocal) await discardTusUpload(datastore, upload.id);

        return {
          status_code: 200,
          headers: {
            "X-Media-Url": result.url,
            "X-Media-Raw-Url": result.rawUrl,
            // The link to put on the clipboard, chosen from the account's
            // `copy_raw` preference exactly as the single-POST path does. Both
            // upload routes have to answer this the same way, or the same file
            // would copy differently depending on whether it happened to be
            // large enough for the client to pick the resumable one.
            "X-Media-Copy-Url": result.copyUrl,
          },
        };
      } catch (err) {
        if (err instanceof QuotaExceededError) throw { status_code: 507, body: err.message };
        if (err instanceof OutOfSpaceError) throw { status_code: 507, body: err.message };
        throw err;
      }
    },
  });

  return server;
}

function quotaAllows(owner: QuotaHolder, incoming: number): boolean {
  const left = remainingQuota(owner);
  return left === null || incoming <= left;
}

/**
 * Drop a finished upload's tus bookkeeping.
 *
 * FileStore.remove() unlinks the payload before touching its record and rejects
 * when the payload is already gone — which is precisely our case, since
 * finalize renamed the temp file into storage. Fall back to deleting the
 * sidecar directly so `data/tus` doesn't accumulate orphaned .json files.
 */
export async function discardTusUpload(store: TusStore, id: string): Promise<void> {
  try {
    await store.remove(id);
    return;
  } catch {
    /* payload already moved — fall through to the record itself */
  }
  try {
    await store.configstore?.delete?.(id);
  } catch (err) {
    console.warn("[tus] could not drop upload record", id, err);
  }
}

/**
 * Delete `.json` records whose payload is gone.
 *
 * FileKvStore.list() only reports ids that still have BOTH files, so a record
 * left behind after finalize moved its payload is invisible to deleteExpired()
 * and would sit in `data/tus` forever — production had 16 of them. We therefore
 * scan the directory ourselves. The grace period is belt-and-braces: FileStore
 * writes the payload before the record, so a payload-less record is never an
 * upload that is mid-creation.
 */
async function reapOrphanedRecords(directory: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return 0; // directory not created yet — nothing to reap
  }

  const payloads = new Set(entries.filter((e) => !e.endsWith(".json")));
  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  let removed = 0;

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (payloads.has(entry.slice(0, -".json".length))) continue;
    const path = join(directory, entry);
    try {
      if ((await stat(path)).mtimeMs > cutoff) continue;
      await rm(path, { force: true });
      removed++;
    } catch {
      /* raced with another sweep — fine */
    }
  }
  return removed;
}

/**
 * One sweep of the tus scratch area, covering both kinds of garbage: uploads
 * that were started and abandoned (the store's own expiration extension), and
 * records whose payload we already adopted into storage.
 */
export async function sweepTusUploads(server: TusServer): Promise<number> {
  const store = server.datastore as unknown as TusStore;
  const orphans = store.directory ? await reapOrphanedRecords(store.directory) : 0;
  const expired = await server.cleanUpExpiredUploads();
  return orphans + expired;
}
