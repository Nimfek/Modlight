import { and, eq, inArray } from "drizzle-orm";
import { resolveApiOwner } from "@/lib/api-caller";
import { readJsonObject } from "@/lib/api-json";
import { db } from "@/lib/db";
import { folders } from "@/lib/db/schema";
import { mediaUrls } from "@/lib/media/urls";
import {
  MAX_CHECKSUMS,
  parseChecksums,
  statusFor,
  type CheckMatch,
  type CheckResponse,
  type CheckResult,
} from "@/lib/upload/duplicate-check";
import { countUnchecksummed, matchesByChecksum } from "@/lib/upload/duplicate-lookup";

/**
 * POST /api/uploads/check - "before I send this, do I already have it?"
 *
 * A separate route rather than a verb on /api/uploads, which was the other
 * option. Two reasons decided it. The collection URL has no POST today, and the
 * only reading anyone brings to `POST /api/uploads` is "create an upload" - a
 * POST that creates nothing, under the URL where creating is the obvious
 * meaning, is a lie about the verb. And the sub-path names the question, so a
 * client author finds it by looking rather than by reading a body schema.
 *
 * POST rather than GET even though nothing changes: 500 sha256 strings are
 * ~33 KB of query string, well past what proxies and access logs will carry
 * intact, and a checksum in a URL is a checksum in nginx's log for a year.
 *
 * Everything here is scoped to the caller and nothing else. A checksum is a
 * global fact about bytes, so an unscoped lookup would answer "does anybody on
 * this server hold this file", which is a question a public host must never
 * answer for anyone.
 *
 * The interesting part is not the query, it is the vocabulary: see
 * lib/upload/duplicate-check.ts for why "no match" is reported as `unknown`
 * rather than `new` whenever the library holds files with no checksum stored.
 * ~8600 imported rows and every resumable upload are in that state, so the
 * confident answer would be wrong for most of this deployment.
 */

export const dynamic = "force-dynamic";

/**
 * Ceiling on the request body.
 *
 * Sized FROM `MAX_CHECKSUMS` rather than copied from the 16 KiB default: a
 * checksum costs 64 characters plus quotes and a comma, so a perfectly legal
 * 500-file question is ~33 KB and the default would have refused it with a 413
 * before the count ceiling ever ran - the client would see a size error for a
 * request within every documented limit. Exactly the bug `PATCH_BODY_MAX` in
 * ../route.ts was sized to avoid.
 */
const CHECK_BODY_MAX = 64 * 1024;

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

const ISSUE_MESSAGE = {
  empty: "No checksums given.",
  malformed: "Every entry must be a sha256 checksum (64 hex characters).",
  "too-many": `Too many checksums (max ${MAX_CHECKSUMS}).`,
} as const;

export async function POST(req: Request): Promise<Response> {
  // Asking "do you already have these bytes" is a read of the library: the
  // answer names the caller's existing files, their folders and their links.
  const auth = await resolveApiOwner(req, "read");
  // Before the body, so an unauthenticated caller cannot make us buffer one.
  if (!auth.ok) return json(auth.body, auth.status);
  const owner = auth.caller;

  const parsedBody = await readJsonObject(req, CHECK_BODY_MAX);
  if (!parsedBody.ok) return json({ message: parsedBody.message }, parsedBody.status);

  // Shape and ceiling BEFORE a query is built, never after: an entry that is not
  // a sha256 must not reach the database at all, or this stops being a lookup
  // and becomes a 500-term search over a column with no business being searched.
  const parsed = parseChecksums(parsedBody.body.checksums);
  if (!parsed.ok) return json({ message: ISSUE_MESSAGE[parsed.issue], reason: parsed.issue }, 400);

  const { checksums } = parsed;

  const [{ byChecksum, truncated }, unchecksummed] = await Promise.all([
    matchesByChecksum(owner.id, checksums),
    countUnchecksummed(owner.id),
  ]);

  const folderNames = await namesFor(owner.id, byChecksum);

  // A library holding files this lookup cannot see is a library about which
  // "you do not have this" cannot be said. See `statusFor`.
  const blind = unchecksummed > 0 || truncated;

  const results: CheckResult[] = checksums.map((checksum) => {
    const rows = byChecksum.get(checksum) ?? [];
    return {
      checksum,
      status: statusFor(rows.length > 0, blind),
      matches: rows.map((row): CheckMatch => {
        // Built from the OWNER's account settings, exactly as the listing route
        // and ShareX's finalize do, so the same file offers the same string
        // wherever it is shown.
        const links = mediaUrls(owner, row.code, row.ext);
        return {
          id: row.id,
          code: row.code,
          filename: row.filename,
          ext: row.ext,
          mimeType: row.mimeType,
          size: Number(row.size),
          createdAt: row.createdAt.toISOString(),
          folderId: row.folderId,
          folderName: row.folderId ? (folderNames.get(row.folderId) ?? null) : null,
          url: links.url,
          rawUrl: links.rawUrl,
          copyUrl: owner.copyRaw ? links.rawUrl : links.url,
        };
      }),
    };
  });

  const payload: CheckResponse = {
    message: "OK",
    requested: checksums.length,
    unchecksummed,
    truncated,
    results,
  };

  return json(payload);
}

/**
 * Names for the folders the matches live in.
 *
 * A separate scoped SELECT rather than a join, for two reasons. It runs at most
 * once per request over a handful of ids instead of widening every matched row,
 * and folding `owner_id` into it means a `folder_id` that somehow pointed
 * outside this account still yields no name rather than leaking one.
 *
 * "Which folder" is the field that makes this answer actionable: a user told
 * they already have the screenshot wants to know where it went, and an id is not
 * an answer to that.
 */
async function namesFor(
  userId: string,
  byChecksum: Map<string, { folderId: string | null }[]>,
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const rows of byChecksum.values()) {
    for (const row of rows) if (row.folderId) ids.add(row.folderId);
  }
  if (ids.size === 0) return new Map();

  const rows = await db
    .select({ id: folders.id, name: folders.name })
    .from(folders)
    .where(and(eq(folders.ownerId, userId), inArray(folders.id, [...ids])));

  return new Map(rows.map((r) => [r.id, r.name] as const));
}
