import { resolveApiOwner } from "@/lib/api-caller";
import { readJsonObject } from "@/lib/api-json";
import { recordAudit } from "@/lib/audit";
import {
  dismissChecksums,
  REMINDER_MIN_BYTES,
  REMINDER_MIN_REDUNDANT,
  reminderDue,
  restoreChecksums,
  scanDuplicates,
  type DismissalInput,
} from "@/lib/data/duplicates";
import { MAX_CHECKSUMS, parseChecksums } from "@/lib/upload/duplicate-check";

/**
 * Retroactive duplicate detection over HTTP, for the desktop client.
 *
 * The panel grew this as three Server Actions on /dashboard/duplicates, and a
 * Server Action is unreachable from a C# app: it is a POST to an opaque action
 * id that changes on every build. So the app could offer the feature only by
 * pulling the whole library down and grouping it itself - which is the one
 * implementation this must never have. `uploads.checksum` is NULL on rows written
 * before checksums were recorded and on every resumable upload, and a client grouping
 * rows in memory would have to decide what NULL means; the SQL below already
 * decided, once, for both surfaces (see lib/data/duplicates.ts).
 *
 * Nothing here re-implements the rules. `scanDuplicates`, `dismissChecksums` and
 * `restoreChecksums` are the exact functions the panel's actions call, so the
 * two surfaces cannot come to disagree about what a duplicate is, which sets are
 * dismissed, or how the totals are counted - the same reason lib/folders.ts and
 * lib/shortlinks.ts were pulled out of their actions before this.
 *
 * TRASHING duplicates has no verb here on purpose: it is `DELETE /api/uploads`
 * with `mode: "trash"`, which already exists, already caps its id list and
 * already refuses to re-stamp a row that is in the trash. A second delete path
 * that happened to be reached from a different screen is exactly how two
 * deletion rules drift apart.
 */

export const dynamic = "force-dynamic";

/**
 * Ceiling on a POST body.
 *
 * Sized FROM `MAX_CHECKSUMS`, not copied from the 16 KiB default: one `keep`
 * entry is a 64-character digest plus two numbers, about 110 bytes once quoted,
 * so a legal 500-set request is ~55 KB and the default would refuse it with a
 * 413 before the count ceiling could give the honest answer.
 */
const BODY_MAX = 96 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // A per-account answer must never be held by a shared cache.
      "cache-control": "private, no-store",
    },
  });
}

/**
 * GET - scan this account's library for duplicate sets.
 *
 * Read-only, and priced like a read: three queries, none of which streams the
 * uploads table into Node. `scope: "read"` for that reason - a client that can
 * only read must still be able to SEE the duplication; removing it is a write
 * and goes through DELETE /api/uploads, which asks for one.
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await resolveApiOwner(req, "read");
  if (!auth.ok) return json(auth.body, auth.status);

  const scan = await scanDuplicates(auth.caller.id);

  return json({
    ...scan,
    /**
     * Whether the account is over one of the two reminder thresholds RIGHT NOW,
     * computed from `active` - the totals with the dismissed sets subtracted.
     *
     * Sent rather than left to the client, and the thresholds are sent with it,
     * because the numbers belong to the server: a client carrying its own copy
     * of "10 files or 1 GB" would go on nagging at the old figures the day
     * either is changed, and the two surfaces would disagree about whether the
     * same library needs cleaning.
     */
    due: reminderDue(scan.active),
    thresholds: { redundant: REMINDER_MIN_REDUNDANT, bytes: REMINDER_MIN_BYTES },
  });
}

const ISSUE_MESSAGE = {
  empty: "No checksums given.",
  malformed: "Every entry must be a sha256 checksum (64 hex characters).",
  "too-many": `Too many checksums (max ${MAX_CHECKSUMS}).`,
} as const;

/** One entry of `keep`, before it has been believed. */
type KeepEntry = { checksum?: unknown; copies?: unknown; bytes?: unknown };

function whole(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * POST - decide what happens to a set the scan found.
 *
 * `{ "keep": [{ "checksum": "...", "copies": 3, "bytes": 123 }] }`
 *   these copies are meant to exist; stop counting them.
 * `{ "countAgain": ["..."] }`
 *   undo that.
 *
 * Keyed by CHECKSUM, never by upload id, and that is the whole design of the
 * dismissed set: trashing one copy must not resurrect the nag for the survivors,
 * and re-uploading the same bytes must not either. See
 * lib/db/schema/duplicates-schema.ts.
 *
 * Exactly one of the two keys per request. A body carrying both would be asking
 * for a set to be dismissed and un-dismissed in one call, and there is no
 * ordering of those two that is more obviously right than the other - so it is
 * refused rather than resolved by whichever branch happens to run second.
 */
export async function POST(req: Request): Promise<Response> {
  // Both verbs change what the account will be told in future, so both are
  // writes - even though neither touches a single byte of anybody's files.
  const auth = await resolveApiOwner(req, "write");
  // Before the body, so an unauthenticated caller cannot make us buffer one.
  if (!auth.ok) return json(auth.body, auth.status);
  const owner = auth.caller;

  const parsedBody = await readJsonObject(req, BODY_MAX);
  if (!parsedBody.ok) return json({ message: parsedBody.message }, parsedBody.status);
  const body = parsedBody.body;

  const wantsKeep = Array.isArray(body.keep);
  const wantsCountAgain = Array.isArray(body.countAgain);

  if (wantsKeep === wantsCountAgain) {
    return json(
      {
        message: "Send exactly one of `keep` or `countAgain`.",
        reason: "one-verb",
      },
      400,
    );
  }

  if (wantsCountAgain) {
    const parsed = parseChecksums(body.countAgain);
    if (!parsed.ok) return json({ message: ISSUE_MESSAGE[parsed.issue], reason: parsed.issue }, 400);

    // Ownership lives inside `restoreChecksums`' WHERE clause. A checksum is a
    // global fact about bytes, so a delete matching on the digest alone would
    // let one account clear another's decision.
    const restored = await restoreChecksums(owner.id, parsed.checksums);

    await recordAudit(owner.id, "uploads.duplicates_counted_again", {
      count: restored,
      requested: parsed.checksums.length,
      via: "api",
    });

    return json({ message: "OK", restored });
  }

  const list = (body.keep as KeepEntry[]).filter(
    (entry): entry is KeepEntry => typeof entry === "object" && entry !== null,
  );

  // The same validator the upload-time check uses, and it matters here for a
  // different reason than there: `duplicate_dismissals.checksum` is a varchar,
  // so an arbitrary string would not be rejected by Postgres the way a malformed
  // uuid is - it would simply be stored, and sit in the table forever matching
  // nothing.
  const parsed = parseChecksums(list.map((entry) => entry.checksum));
  if (!parsed.ok) return json({ message: ISSUE_MESSAGE[parsed.issue], reason: parsed.issue }, 400);

  // `parseChecksums` lower-cases and de-duplicates, so the copies/bytes note is
  // matched back by the NORMALISED digest rather than by position in the input.
  const byChecksum = new Map<string, DismissalInput>();
  for (const entry of list) {
    const checksum = typeof entry.checksum === "string" ? entry.checksum.trim().toLowerCase() : "";
    if (checksum) {
      byChecksum.set(checksum, {
        checksum,
        copies: whole(entry.copies),
        bytes: whole(entry.bytes),
      });
    }
  }

  const entries: DismissalInput[] = parsed.checksums.map(
    (checksum) => byChecksum.get(checksum) ?? { checksum, copies: 0, bytes: 0 },
  );

  const kept = await dismissChecksums(owner.id, entries);

  await recordAudit(owner.id, "uploads.duplicates_kept", {
    count: kept,
    requested: parsed.checksums.length,
    via: "api",
  });

  return json({ message: "OK", kept, checksums: parsed.checksums });
}
