"use server";

/**
 * Converting files from the panel: one file, or a whole selection.
 *
 * Nothing but identifiers crosses this boundary - an upload id and a target
 * name - so the 1 MB body limit a Server Action carries never enters into it,
 * however large the file being converted is. The bytes are read from storage and
 * written back to storage entirely on the server (lib/media/convert-in-place.ts).
 *
 * These are WRITES, and destructive ones in `replace` mode, so every entry point
 * resolves the session itself. The route that serves conversions to the public
 * is a different module on purpose and gains nothing from this one.
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, uploads } from "@/lib/db/schema";
import { getSession } from "@/lib/auth-helpers";
import { clientIp } from "@/lib/password";
import { convertUploadInPlace } from "@/lib/media/convert-in-place";
import {
  bulkTargetSummary,
  convertTargetsForRow,
  type ConvertMode,
  type ConvertOutcome,
  type ConvertReport,
  type TargetSummary,
} from "@/lib/media/convert-plan";
import type { DownloadOption } from "@/lib/media/download-menu";

/**
 * How many files one call may convert.
 *
 * The limiter admits two transforms at a time across the whole server and an
 * encode may take a minute, so a selection of a hundred would be a request that
 * cannot finish. The cap is the honest bound, and the UI splits anything larger.
 */
const MAX_BATCH = 25;

// ---------------------------------------------------------------------------
// What may be offered
// ---------------------------------------------------------------------------

/** Targets for one file, in the same order the "Download as…" menu uses. */
export async function convertTargetsForUpload(id: string): Promise<DownloadOption[]> {
  const rows = await loadOwned([id]);
  const row = rows[0];
  return row ? convertTargetsForRow(row) : [];
}

/**
 * Targets for a SELECTION, each carrying how many of the selected files it
 * applies to.
 *
 * The union rather than the intersection: with mixed types the intersection is
 * usually empty, and a menu that offers nothing for eight selected files is a
 * menu that is wrong. The counts are what let the UI say "PNG, 5 of 8" before
 * anything is clicked instead of reporting the shortfall afterwards.
 */
export async function convertTargetsForSelection(
  ids: string[],
  mode: ConvertMode = "replace",
): Promise<TargetSummary[]> {
  const rows = await loadOwned(ids);
  return bulkTargetSummary(rows, mode);
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

/** Convert one file, replacing it or leaving a copy beside it. */
export async function convertUpload(
  id: string,
  to: string,
  mode: ConvertMode,
): Promise<ConvertOutcome> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");

  const outcome = await convertUploadInPlace({
    uploadId: id,
    to,
    mode,
    actor: { id: session.user.id, role: session.user.role },
  });

  await afterConversion(session.user.id, [outcome], to, mode);
  return outcome;
}

/**
 * Convert a selection to one target.
 *
 * Strictly one file at a time. The shared limiter has room for two transforms
 * across the entire server (lib/media/transform-cost.ts), so firing a selection
 * in parallel would not go faster - it would refuse its own later files with a
 * "too many transforms" error and take every thumbnail on the site down with it.
 *
 * Each file is its own transaction, so a failure in the middle keeps everything
 * already done. Files that are already in the target format are reported as
 * skipped rather than attempted, which is the case a mixed selection produces
 * constantly: five JPEGs and three PNGs asked for PNG is five conversions and
 * three files with nothing to do.
 */
export async function convertUploads(
  ids: string[],
  to: string,
  mode: ConvertMode,
): Promise<ConvertReport> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");

  const unique = [...new Set(ids)].slice(0, MAX_BATCH);
  const results: ConvertOutcome[] = [];

  for (const id of unique) {
    results.push(
      await convertUploadInPlace({
        uploadId: id,
        to,
        mode,
        actor: { id: session.user.id, role: session.user.role },
      }),
    );
  }

  await afterConversion(session.user.id, results, to, mode);

  return {
    to,
    mode,
    converted: results.filter((r) => r.status === "converted" || r.status === "created").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * The rows the caller may act on: their own, or anybody's for an admin.
 *
 * The same rule `convertUploadInPlace` enforces before it writes anything. It is
 * repeated here so the MENU cannot advertise targets for a file the caller is
 * not allowed to touch, which would be an offer that always fails.
 */
async function loadOwned(ids: string[]) {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");

  const unique = [...new Set(ids)].filter(Boolean).slice(0, 500);
  if (unique.length === 0) return [];

  const rows = await db
    .select({
      id: uploads.id,
      ownerId: uploads.ownerId,
      ext: uploads.ext,
      mimeType: uploads.mimeType,
      frames: uploads.frames,
      // Read for one reason: the web-playable target is offered only to a
      // recording whose own dimensions put it past a hardware decoder. Without
      // these two columns the panel's Convert menu would silently be missing the
      // entry the "Download as..." menu beside it is showing.
      width: uploads.width,
      height: uploads.height,
      size: uploads.size,
      kind: uploads.kind,
      deletedAt: uploads.deletedAt,
      expiresAt: uploads.expiresAt,
    })
    .from(uploads)
    .where(inArray(uploads.id, unique));

  return session.user.role === "admin"
    ? rows
    : rows.filter((r) => r.ownerId === session.user.id);
}

/**
 * Refresh what the conversion changed, and record it when somebody else's file
 * was rewritten.
 *
 * The public page needs nothing: it is force-dynamic and every view picks its
 * shape from the row's MIME type, so an MP4 that became a GIF stops rendering as
 * a video player and starts rendering as a picture on the very next request. The
 * dashboard is the one that has to be told, because it is a cached server
 * component and would otherwise keep drawing the old row.
 */
async function afterConversion(
  actorId: string,
  results: ConvertOutcome[],
  to: string,
  mode: ConvertMode,
): Promise<void> {
  const changed = results.filter((r) => r.status === "converted" || r.status === "created");
  if (changed.length === 0) return;

  revalidatePath("/dashboard");

  const foreign = await foreignIds(actorId, changed);
  if (foreign.length === 0) return;

  // An admin rewriting somebody else's bytes is the one case here that destroys
  // data the actor does not own, so it is written down. Never fatal: losing the
  // log entry must not lose the conversion.
  try {
    await db.insert(auditLog).values({
      userId: actorId,
      action: mode === "replace" ? "convert.replace" : "convert.copy",
      detail: { to, uploadIds: foreign },
      ip: clientIp(await headers()),
    });
  } catch (err) {
    console.error("[audit] could not record conversion:", err);
  }
}

/** Which of these rows belong to somebody other than the actor. */
async function foreignIds(actorId: string, results: ConvertOutcome[]): Promise<string[]> {
  const ids = results
    .map((r) => (r.status === "converted" ? r.uploadId : r.status === "created" ? r.sourceId : null))
    .filter((id): id is string => !!id);
  if (ids.length === 0) return [];

  const rows = await db
    .select({ id: uploads.id, ownerId: uploads.ownerId })
    .from(uploads)
    .where(inArray(uploads.id, ids));

  return rows.filter((r) => r.ownerId !== actorId).map((r) => r.id);
}
