"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads } from "@/lib/db/schema";
import { getSession } from "@/lib/auth-helpers";
import { recordAudit } from "@/lib/audit";
import { purgeDerived } from "@/lib/media/derived-cache";
import {
  dismissChecksums,
  parseUploadIds,
  restoreChecksums,
  scanDuplicates,
  type DismissalInput,
  type DuplicateScan,
  type IdListIssue,
} from "@/lib/data/duplicates";
import { parseChecksums, type ChecksumListIssue } from "@/lib/upload/duplicate-check";

/**
 * Retroactive duplicate cleanup, driven from the profile page.
 *
 * Both actions answer with DATA. Next masks the message of anything thrown from
 * a Server Action in production ("An error occurred in the Server Components
 * render"), so a thrown string is a message the user will never read - and this
 * is a screen whose entire job is telling somebody precisely what it is about
 * to delete and why it refused.
 */

export type ScanResult =
  | { ok: true; scan: DuplicateScan }
  | { ok: false; error: "unauthorized" | "failed" };

/** How many storage prefixes we clear at a time (mirrors lib/media/actions.ts). */
const PURGE_CONCURRENCY = 16;

/** Ids kept in the audit entry. The count is the fact; the list is a courtesy. */
const AUDIT_ID_SAMPLE = 50;

/** Read-only scan of the signed-in account. Never touches another account. */
export async function scanMyDuplicates(): Promise<ScanResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthorized" };

  try {
    return { ok: true, scan: await scanDuplicates(session.user.id) };
  } catch (err) {
    console.error("[duplicates] scan failed:", err);
    return { ok: false, error: "failed" };
  }
}

export type TrashResult =
  | {
      ok: true;
      /** Rows this call actually stamped. */
      trashed: number;
      /** Bytes now sitting in the trash. NOT returned to the quota yet. */
      bytes: number;
      /**
       * Ids that were asked for but not stamped: already trashed, already gone,
       * or never this account's to begin with. Deliberately one number - telling
       * a caller WHICH ids belong to somebody else is an ownership oracle.
       */
      skipped: number;
    }
  | { ok: false; error: "unauthorized" | IdListIssue | "failed" };

/**
 * Move a caller-supplied list of uploads to the trash.
 *
 * Soft-delete, never a hard delete. This is the one feature in the app where a
 * mistake is both easy (a mis-read "keep the oldest" default) and total (the
 * only other copy), so everything it removes has to be sitting in the 30-day
 * trash afterwards, restorable from /dashboard/trash with one click.
 *
 * Ownership lives in the WHERE clause. Not "select the rows, check the owner,
 * then update": between those two statements the rows can change hands or be
 * trashed by another session, and the check would be answering a question about
 * a version of the table that no longer exists. One statement, and its
 * `returning()` is the authoritative record of what really happened - which is
 * also where the byte total comes from, rather than from whatever the client
 * believed it was selecting.
 */
export async function trashDuplicates(ids: string[]): Promise<TrashResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthorized" };

  const parsed = parseUploadIds(ids);
  if (!parsed.ok) return { ok: false, error: parsed.issue };

  let trashedRows: { id: string; size: number; code: string }[];
  try {
    trashedRows = await db
      .update(uploads)
      .set({ deletedAt: new Date() })
      .where(
        and(
          inArray(uploads.id, parsed.ids),
          eq(uploads.ownerId, session.user.id),
          // Already in the trash means already stamped, and re-stamping hands
          // the file another thirty days - the same trap softDeleteMedia guards.
          isNull(uploads.deletedAt),
        ),
      )
      .returning({ id: uploads.id, size: uploads.size, code: uploads.code });
  } catch (err) {
    console.error("[duplicates] trash failed:", err);
    return { ok: false, error: "failed" };
  }

  const bytes = trashedRows.reduce((sum, r) => sum + Number(r.size || 0), 0);

  // Cached conversions are pure derivatives of a file the owner has just said
  // they no longer want served, so they go now even though the original stays.
  // Best-effort by design: purgeDerived swallows its own failures, and a cache
  // we could not clear must never turn a completed delete into a failed one.
  for (let i = 0; i < trashedRows.length; i += PURGE_CONCURRENCY) {
    await Promise.all(
      trashedRows.slice(i, i + PURGE_CONCURRENCY).map((row) => purgeDerived(row.id)),
    );
  }

  if (trashedRows.length > 0) {
    await recordAudit(session.user.id, "uploads.duplicates_trashed", {
      count: trashedRows.length,
      bytes,
      requested: parsed.ids.length,
      codes: trashedRows.slice(0, AUDIT_ID_SAMPLE).map((r) => r.code),
    });
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/trash");
  revalidatePath("/dashboard/profile");
  revalidatePath("/dashboard/duplicates");
  // The reminder strip lives in the panel shell, so its totals are stale for
  // every route until the layout itself is re-rendered.
  revalidatePath("/dashboard", "layout");

  return {
    ok: true,
    trashed: trashedRows.length,
    bytes,
    skipped: parsed.ids.length - trashedRows.length,
  };
}

/* -------------------------------------------------------------------------- */
/* The dismissed set: "these copies are meant to exist"                        */
/* -------------------------------------------------------------------------- */

/** Checksums named in one audit entry. Same courtesy as the id sample above. */
const AUDIT_CHECKSUM_SAMPLE = 20;

export type KeepResult =
  | { ok: true; kept: number; checksums: string[] }
  | { ok: false; error: "unauthorized" | ChecksumListIssue | "failed" };

/**
 * Record that these sets are meant to have copies, so the reminder stops
 * counting them.
 *
 * This is the ONLY thing that makes the reminder bearable. Its rule, in the
 * owner's words: if the user says they do not want those files removed, never
 * remind about them again, and count the next threshold from zero. Both halves
 * fall out of `duplicateReminderQuery`, which anti-joins this table: a dismissed
 * set contributes nothing to `redundant` or `reclaimable`, so the next reminder
 * is triggered by whatever has arrived SINCE, not by the pile that was settled.
 *
 * Keyed by checksum, never by upload id - see lib/db/schema/duplicates-schema.ts.
 * The short version: trashing one copy of a dismissed set must not resurrect the
 * nag for the survivors, and re-uploading the same bytes must not either.
 *
 * `parseChecksums` is the same validator the upload-time check uses. It matters
 * here for a different reason than there: `duplicate_dismissals.checksum` is a
 * varchar, so an arbitrary string would not be rejected by Postgres the way a
 * malformed uuid is - it would simply be stored, and the row would sit in the
 * table forever matching nothing.
 */
export async function keepDuplicateSets(sets: DismissalInput[]): Promise<KeepResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthorized" };

  const list = Array.isArray(sets) ? sets : [];
  const parsed = parseChecksums(list.map((set) => set?.checksum));
  if (!parsed.ok) return { ok: false, error: parsed.issue };

  // `parseChecksums` lower-cases and de-duplicates, so the copies/bytes note is
  // matched back by the NORMALISED digest rather than by position in the input.
  const byChecksum = new Map<string, DismissalInput>();
  for (const set of list) {
    const checksum = typeof set?.checksum === "string" ? set.checksum.trim().toLowerCase() : "";
    if (checksum) byChecksum.set(checksum, { ...set, checksum });
  }

  const entries: DismissalInput[] = parsed.checksums.map(
    (checksum) => byChecksum.get(checksum) ?? { checksum, copies: 0, bytes: 0 },
  );

  let kept: number;
  try {
    kept = await dismissChecksums(session.user.id, entries);
  } catch (err) {
    console.error("[duplicates] keep failed:", err);
    return { ok: false, error: "failed" };
  }

  await recordAudit(session.user.id, "uploads.duplicates_kept", {
    count: kept,
    requested: parsed.checksums.length,
    checksums: parsed.checksums.slice(0, AUDIT_CHECKSUM_SAMPLE),
  });

  revalidatePath("/dashboard/duplicates");
  revalidatePath("/dashboard", "layout");

  return { ok: true, kept, checksums: parsed.checksums };
}

export type CountAgainResult =
  | { ok: true; restored: number }
  | { ok: false; error: "unauthorized" | ChecksumListIssue | "failed" };

/**
 * Undo the above: start counting these sets again.
 *
 * Present for two reasons, and the second is the important one. It is the Undo
 * behind the toast, so waving a set off is a decision that can be taken back in
 * the same second it was made - and it is the way out of "keep everything
 * listed", which is one click away from silencing the reminder for good.
 *
 * Ownership is inside `restoreChecksums`' WHERE clause. A checksum is a global
 * fact about bytes, so a delete matching on the digest alone would let one
 * account clear another's decision.
 */
export async function countDuplicateSetsAgain(checksums: string[]): Promise<CountAgainResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthorized" };

  const parsed = parseChecksums(checksums);
  if (!parsed.ok) return { ok: false, error: parsed.issue };

  let restored: number;
  try {
    restored = await restoreChecksums(session.user.id, parsed.checksums);
  } catch (err) {
    console.error("[duplicates] count-again failed:", err);
    return { ok: false, error: "failed" };
  }

  await recordAudit(session.user.id, "uploads.duplicates_counted_again", {
    count: restored,
    requested: parsed.checksums.length,
    checksums: parsed.checksums.slice(0, AUDIT_CHECKSUM_SAMPLE),
  });

  revalidatePath("/dashboard/duplicates");
  revalidatePath("/dashboard", "layout");

  return { ok: true, restored };
}
