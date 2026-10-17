// NOTE: deliberately free of `server-only`, like lib/folders.ts,
// lib/upload/folder-target.ts and lib/maintenance/trash.ts. `server-only` is not
// an installed package - it resolves only inside Next's bundler and inside
// vitest's stub - so a module carrying it that ever reached the esbuild bundle
// would put the bare specifier into dist/server.js and kill `node dist/server.js`
// at link time, before server.listen(). Nothing reachable from server.ts imports
// this file today, and scripts/check-server-bundle.mjs is the backstop that
// turns a future mistake into a red build instead of a crash loop.
//
// (It would catch one here for certain: `recordAudit` below pulls in
// lib/audit.ts, which DOES carry the guard. That is deliberate - this module is
// Next-graph-only by construction, and the build says so out loud rather than
// leaving it to a comment.)
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { deleteMediaBulk, type DeletableMedia } from "@/lib/media/actions";
import { slugify } from "@/lib/ids";
import { isReservedTag } from "@/lib/naming";
import { hashPassword } from "@/lib/password";
import { isUuid } from "@/lib/upload/folder-target";

/**
 * What can be done to an upload after it exists, with no idea who is logged in.
 *
 * Publish/unpublish, the vanity code and the three link settings (expiry, view
 * cap, password) used to live only inside `app/actions/uploads.ts`, reachable
 * only with a session cookie - which is why the desktop client could see a file
 * and change nothing about it. Each function now takes the ACTOR instead of
 * calling `getSession()`, so the panel's Server Actions and
 * `app/api/uploads/route.ts` run the same code rather than two implementations
 * of the same rules.
 *
 * The precedent is `lib/shortlinks.ts` and `lib/folders.ts`, and the reason is
 * the same one: the `javascript:` block lived in only one of two shortener paths
 * and the path without it was an XSS hole. The rules that must not diverge here
 * are:
 *
 *  - slug normalisation and the clash check for a vanity code, which decides
 *    what URL a file answers on;
 *  - `passwordVersion` being cleared whenever a per-file password is set. That
 *    column means "this file is on the ACCOUNT's default password", which is the
 *    sole thing letting a recipient's remembered consent open a file it was not
 *    minted for. Leaving it behind is the difference between "I gave this file
 *    its own password" and "everyone who ever unlocked one of my files can still
 *    read it";
 *  - the view-cap floor (a cap of zero is a file nobody can open, including its
 *    owner, and is always a typo for one);
 *  - the audit entry an administrator's touch on somebody else's file leaves.
 *
 * `revalidatePath` stays in the actions. It is a Next router-cache concern and
 * means nothing to an HTTP client.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Why an operation was refused.
 *
 * Travels as a field on the error rather than being inferred from its message:
 * the panel shows the message, the HTTP surface maps the reason to a status, and
 * neither should be parsing English to find out what happened.
 */
export type UploadIssue =
  | "not-found"
  | "invalid-code"
  | "code-too-long"
  | "code-reserved"
  | "code-taken"
  | "invalid-date"
  | "invalid-views"
  | "password-too-long";

export class UploadOpError extends Error {
  readonly reason: UploadIssue;

  constructor(reason: UploadIssue, message: string) {
    super(message);
    this.name = "UploadOpError";
    this.reason = reason;
  }
}

const notFound = () => new UploadOpError("not-found", "Not found");

export type UploadRecord = typeof uploads.$inferSelect;

/**
 * Who is asking, and how far their reach goes.
 *
 * `isAdmin` is what makes the panel's admin file browser work at all: an
 * administrator may act on any account's file. It is a privilege the HTTP
 * surface deliberately does not hand out - see app/api/uploads/route.ts - so the
 * default is the safe one.
 */
export interface UploadActor {
  userId: string;
  /** Recorded on an administrative touch, never used to decide anything. */
  email?: string | null;
  isAdmin?: boolean;
}

/** Ceiling on how many rows one call may touch. */
export const UPLOAD_BATCH_MAX = 500;

/** `uploads.code` is a varchar(64); a longer slug is a 500 waiting to happen. */
export const VANITY_CODE_MAX = 64;

/**
 * Longest password accepted. scrypt is deliberately expensive and its first step
 * is linear in the length of the input, so an unbounded one is CPU the caller
 * gets to spend for us. Same bound as app/api/shortlinks/route.ts.
 */
export const UPLOAD_PASSWORD_MAX = 1024;

/* -------------------------------------------------------------------------- */
/* Scoping                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The WHERE clause every read and write below is built from.
 *
 * Ownership is IN the query rather than checked after the rows come back, so
 * another account's id and an id that never existed produce the SAME answer - as
 * does a string that is not a uuid at all, which is dropped before Postgres ever
 * sees it (`uploads.id` is a uuid column, so a malformed one would otherwise be
 * a 500 that says "well formed but unknown" by omission).
 *
 * The old `ownedUpload` in app/actions/uploads.ts read the row unscoped and then
 * threw "Not found" or "Forbidden" depending on who owned it. That distinction
 * is gone on purpose: it was an oracle for "is this upload id real, and whose is
 * it".
 */
function scope(actor: UploadActor, ids: string[]): SQL | undefined {
  const parts: (SQL | undefined)[] = [inArray(uploads.id, ids)];
  // An administrator reaches every row; everyone else reaches their own.
  if (!actor.isAdmin) parts.push(eq(uploads.ownerId, actor.userId));
  return and(...parts);
}

/** Ids worth sending to Postgres: strings, uuid-shaped, unique, bounded. */
function cleanIds(ids: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const v of ids) {
    if (typeof v === "string" && isUuid(v)) seen.add(v);
    if (seen.size >= UPLOAD_BATCH_MAX) break;
  }
  return [...seen];
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Record an administrative touch on ANOTHER account's file. No-op otherwise.
 *
 * Touching somebody else's file leaves no trace in the file itself, so without
 * this "who unpublished my upload?" has no answer that survives the session.
 * Exported because the trash actions in app/actions/uploads.ts leave the same
 * kind of entry for operations that are not link settings.
 */
export async function auditForeignUpload(
  actor: UploadActor,
  media: Pick<UploadRecord, "id" | "code" | "filename" | "ownerId">,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  if (media.ownerId === actor.userId) return;
  await recordAudit(actor.userId, action, {
    by: actor.userId,
    byEmail: actor.email ?? null,
    uploadId: media.id,
    code: media.code,
    filename: media.filename,
    ownerId: media.ownerId,
    ...detail,
  });
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/** The rows out of `ids` this actor may act on. Silently drops the rest. */
export async function actionableUploads(
  actor: UploadActor,
  ids: readonly unknown[],
): Promise<UploadRecord[]> {
  const clean = cleanIds(ids);
  if (!clean.length) return [];
  return db.select().from(uploads).where(scope(actor, clean));
}

/** One row, or a refusal that cannot be told apart from "no such id". */
export async function getActionableUpload(
  actor: UploadActor,
  id: string,
): Promise<UploadRecord> {
  if (typeof id !== "string" || !isUuid(id)) throw notFound();
  const rows = await db.select().from(uploads).where(scope(actor, [id])).limit(1);
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Apply one patch to every row the actor may reach, and say what they now look
 * like.
 *
 * The rows are read first and the UPDATE is then scoped to the ids that read
 * matched, so the write can never reach further than the read did. The returned
 * records are the pre-images with the patch folded in - the caller gets the new
 * state without a third round trip, and none of these columns is computed by the
 * database.
 */
async function applyToUploads(
  actor: UploadActor,
  ids: readonly unknown[],
  patch: Partial<UploadRecord>,
  audit: { action: string; detail: Record<string, unknown> },
): Promise<UploadRecord[]> {
  const rows = await actionableUploads(actor, ids);
  if (!rows.length) return [];

  const updatedAt = new Date();
  await db
    .update(uploads)
    .set({ ...patch, updatedAt })
    .where(scope(actor, rows.map((r) => r.id)));

  for (const row of rows) {
    await auditForeignUpload(actor, row, audit.action, audit.detail);
  }

  return rows.map((r) => ({ ...r, ...patch, updatedAt }));
}

/** Publish or unpublish. May name many ids; unmatched ones are simply absent. */
export async function setPublishedFor(
  actor: UploadActor,
  ids: readonly unknown[],
  published: boolean,
): Promise<UploadRecord[]> {
  return applyToUploads(actor, ids, { published }, {
    action: "admin.upload.published",
    detail: { published },
  });
}

/**
 * Point a file at a custom URL.
 *
 * Single-id by nature: `uploads.code` is globally unique (uploads_code_idx) and
 * two files cannot share one URL, so there is nothing sensible for a list to
 * mean here.
 *
 * The clash check looks at EVERY account's codes, including files in the trash -
 * a trashed row still holds its code and can be restored onto it. The unique
 * index is checked again by Postgres afterwards because the gap between the
 * SELECT and the UPDATE is a real race: two clients claiming the same slug at
 * once both see it free. That violation comes back as `code-taken` rather than
 * as a 500, which is what it means.
 */
export async function setVanityFor(
  actor: UploadActor,
  id: string,
  vanity: string,
): Promise<UploadRecord> {
  const media = await getActionableUpload(actor, id);

  const code = slugify(typeof vanity === "string" ? vanity : "");
  if (!code) throw new UploadOpError("invalid-code", "Invalid vanity");
  // A name the application already owns can never be served as a file.
  //
  // For an account with `skipTagInUrl` the public link is /{code}, so a code of
  // "login" or "dashboard" loses to the real route in Next's resolution order:
  // the file becomes permanently unreachable AND the code stays consumed by the
  // unique index, so nobody else can have it either. Refusing a name that
  // provably cannot work is not a restriction - accepting it was the bug.
  if (isReservedTag(code)) {
    throw new UploadOpError("code-reserved", `"${code}" is reserved by the app`);
  }
  if (code.length > VANITY_CODE_MAX) {
    throw new UploadOpError(
      "code-too-long",
      `Custom URL must be at most ${VANITY_CODE_MAX} characters`,
    );
  }
  // Asking for the code it already has is not a clash with itself.
  if (code === media.code) return media;

  const clash = await db
    .select({ id: uploads.id })
    .from(uploads)
    .where(eq(uploads.code, code))
    .limit(1);
  if (clash[0] && clash[0].id !== media.id) {
    throw new UploadOpError("code-taken", "That URL is already taken");
  }

  try {
    await db
      .update(uploads)
      .set({ code, updatedAt: new Date() })
      .where(scope(actor, [media.id]));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new UploadOpError("code-taken", "That URL is already taken");
    }
    throw err;
  }

  await auditForeignUpload(actor, media, "admin.upload.link_changed", {
    from: media.code,
    to: code,
  });

  return { ...media, code };
}

/** Postgres 23505: somebody claimed the code between our SELECT and our UPDATE. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

/**
 * Set or clear a time-based expiry. Enforcement lives in lib/media/serve.ts,
 * which 404s an expired file for EVERYONE, its owner included.
 */
export async function setExpiryFor(
  actor: UploadActor,
  ids: readonly unknown[],
  when: string | Date | null,
): Promise<UploadRecord[]> {
  const expiresAt = parseExpiry(when);
  return applyToUploads(actor, ids, { expiresAt }, {
    action: "admin.upload.link_changed",
    detail: { expiresAt: expiresAt ? expiresAt.toISOString() : null },
  });
}

function parseExpiry(when: string | Date | null): Date | null {
  if (when === null || when === undefined || when === "") return null;
  const date = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(date.getTime())) throw new UploadOpError("invalid-date", "Invalid date");
  return date;
}

/**
 * Set a view cap (burn after N views), or null to clear. 1 is a one-time link.
 *
 * Floored at 1 rather than refused: a zero or a negative number is always a typo
 * for "one", and storing it would mint a link nobody can ever open - the owner
 * least of all, since `getMedia` applies the cap to them too.
 */
export async function setMaxViewsFor(
  actor: UploadActor,
  ids: readonly unknown[],
  maxViews: number | null,
): Promise<UploadRecord[]> {
  let value: number | null = null;
  if (maxViews !== null && maxViews !== undefined) {
    if (typeof maxViews !== "number" || !Number.isFinite(maxViews)) {
      throw new UploadOpError("invalid-views", "View limit must be a number");
    }
    value = Math.max(1, Math.floor(maxViews));
  }
  return applyToUploads(actor, ids, { maxViews: value }, {
    action: "admin.upload.link_changed",
    detail: { maxViews: value },
  });
}

/**
 * Set or clear a per-file password. `null` or an empty string clears it.
 *
 * `passwordVersion` is cleared along with it, ALWAYS - see the module comment.
 * That single column decides whether a recipient's 30-day "remember this" cookie
 * opens the file, so a password chosen for this one file has to give it up.
 *
 * Hashed ONCE for the whole batch: scrypt is expensive on purpose, and doing it
 * per row would turn a 500-file selection into 500 deliberate slowdowns.
 */
export async function setPasswordFor(
  actor: UploadActor,
  ids: readonly unknown[],
  password: string | null,
): Promise<UploadRecord[]> {
  if (typeof password === "string" && password.length > UPLOAD_PASSWORD_MAX) {
    throw new UploadOpError(
      "password-too-long",
      `Password must be at most ${UPLOAD_PASSWORD_MAX} characters`,
    );
  }
  const passwordHash =
    typeof password === "string" && password.length > 0 ? await hashPassword(password) : null;

  return applyToUploads(actor, ids, { passwordHash, passwordVersion: null }, {
    action: "admin.upload.link_changed",
    // The password itself is never recorded; that it changed is the fact worth
    // keeping, because it can lock the owner out of their own link.
    detail: { passwordSet: Boolean(passwordHash) },
  });
}

/* -------------------------------------------------------------------------- */
/* Trash                                                                       */
/* -------------------------------------------------------------------------- */

/** What is sitting in one account's trash right now. */
export interface TrashTotals {
  /** Rows in the trash. */
  files: number;
  /** Bytes those rows still occupy in storage. */
  bytes: number;
}

export interface EmptyTrashResult extends TrashTotals {
  /**
   * Rows storage refused to release. They stay in the trash, so a retry - or the
   * thirty-day sweep in lib/maintenance/trash.ts - finds them again instead of
   * us quietly forgetting the disk space.
   */
  failed: number;
}

/** Rows read, and destroyed, per round trip. */
const TRASH_PURGE_BATCH = 200;

/** Hard stop, so one call can never run away with the database. */
const TRASH_PURGE_MAX_ROUNDS = 500;

/**
 * Whose trash a request is about, named by the tag every link on the page is
 * built from.
 *
 * The tag rather than an id because it is the one identifier BOTH callers
 * already hold: the owner's own trash page and an administrator's view of
 * somebody else's library hand the same `userCode` to the same component. Taking
 * the target from something only one of them knows is how an "empty trash"
 * button ends up emptying the ADMINISTRATOR's own trash while it is pointed at
 * another account's library - which is exactly the bug this closes.
 *
 * Retired tags (`user_code_aliases`) are deliberately NOT consulted. An alias
 * exists so a link somebody already shared keeps working; aiming a permanent
 * delete with a name its owner has since given up is a way to destroy the wrong
 * library, and no panel view renders one.
 *
 * An empty tag, an unknown tag and another account's tag are ONE answer for
 * anybody who is not an administrator, for the same reason `scope()` folds
 * ownership into the WHERE: anything else is an oracle for "is this tag taken,
 * and by whom".
 */
async function trashOwnerId(actor: UploadActor, ownerTag: string): Promise<string> {
  if (typeof ownerTag !== "string" || ownerTag.length === 0) throw notFound();

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.userCode, ownerTag))
    .limit(1);

  const target = rows[0];
  if (!target) throw notFound();
  if (target.id !== actor.userId && !actor.isAdmin) throw notFound();
  return target.id;
}

/**
 * The clause every trash-wide operation below is built from.
 *
 * `deleted_at IS NOT NULL` is part of the WHERE rather than a check on rows that
 * have already come back - the discipline `deleteOrphan` uses for
 * `owner_id IS NULL`, and for the same reason. It is what makes it impossible
 * for this path to reach a LIVE file: there is no id parameter anywhere in it,
 * so a stale selection in a browser tab left open cannot name one, and a file
 * restored before the query runs is simply not in the result.
 */
function trashScope(ownerId: string): SQL | undefined {
  return and(eq(uploads.ownerId, ownerId), isNotNull(uploads.deletedAt));
}

/**
 * How much is in that trash, counted over the whole table.
 *
 * Deliberately not derived from the rows the panel is showing: the trash view
 * renders one page of 120, so "120 items will be permanently deleted" could be
 * an order of magnitude short of the truth on an account that has been tidying
 * up. A confirmation that understates what it destroys is worse than one that
 * gives no number at all.
 */
export async function trashTotalsFor(
  actor: UploadActor,
  ownerTag: string,
): Promise<TrashTotals> {
  const ownerId = await trashOwnerId(actor, ownerTag);

  const rows = await db
    .select({
      files: count(),
      // `coalesce`, because SUM over no rows is NULL rather than 0.
      bytes: sql<string>`coalesce(sum(${uploads.size}), 0)`,
    })
    .from(uploads)
    .where(trashScope(ownerId));

  const row = rows[0];
  return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/**
 * Permanently delete everything in that trash, now, instead of waiting out the
 * thirty-day retention window.
 *
 * The bytes go with the rows: this hands its batches to `deleteMediaBulk`, the
 * same core the orphan purge and account deletion use, rather than deleting rows
 * and leaving the storage objects behind. That core deletes the object FIRST and
 * keeps the row when storage refuses, which is why `failed` exists here at all -
 * a row we could not clear stays in the trash and is reported, instead of the
 * disk space silently becoming nobody's problem.
 *
 * Batched, and rows storage refused are parked in `stuck` and excluded from the
 * next query: without that they come back in every batch, are counted again each
 * time, and the loop spins forever once only they are left.
 *
 * KNOWN BOUND, shared with `purgeAllOrphans`: `deleteMediaBulk` deletes its rows
 * by id, so a file restored in another tab between our SELECT and that DELETE is
 * destroyed anyway. Closing it needs the same `deleted_at IS NOT NULL` guard
 * inside that DELETE, in lib/media/actions.ts.
 */
export async function emptyTrashFor(
  actor: UploadActor,
  ownerTag: string,
): Promise<EmptyTrashResult> {
  const ownerId = await trashOwnerId(actor, ownerTag);

  const stuck: string[] = [];
  let files = 0;
  let bytes = 0;

  for (let round = 0; round < TRASH_PURGE_MAX_ROUNDS; round++) {
    const where = [trashScope(ownerId)];
    if (stuck.length > 0) where.push(notInArray(uploads.id, stuck));

    const batch: DeletableMedia[] = await db
      .select({
        id: uploads.id,
        ownerId: uploads.ownerId,
        size: uploads.size,
        storageKey: uploads.storageKey,
        thumbKey: uploads.thumbKey,
      })
      .from(uploads)
      .where(and(...where))
      // Oldest first, so an interrupted run has taken out the items closest to
      // expiring rather than a random slice.
      .orderBy(asc(uploads.deletedAt))
      .limit(TRASH_PURGE_BATCH);

    if (batch.length === 0) break;

    const result = await deleteMediaBulk(batch);
    files += result.deleted;
    bytes += result.bytes;

    if (result.failed > 0) {
      // `deleteMediaBulk` removes exactly the rows it managed to clear, so
      // whatever is still there is what storage would not give up.
      const survivors = await db
        .select({ id: uploads.id })
        .from(uploads)
        .where(inArray(uploads.id, batch.map((r) => r.id)));
      for (const s of survivors) stuck.push(s.id);
    }
  }

  // Emptying somebody else's trash leaves no trace in the files themselves -
  // they are gone - so this is the only place the fact can be written down.
  // Once for the operation rather than once per file: an administrator clearing
  // a thousand items would otherwise bury every other entry in the log.
  if (ownerId !== actor.userId) {
    await recordAudit(actor.userId, "admin.trash.emptied", {
      by: actor.userId,
      byEmail: actor.email ?? null,
      ownerId,
      ownerTag,
      files,
      bytes,
      failed: stuck.length,
    });
  }

  return { files, bytes, failed: stuck.length };
}
