// NOTE: deliberately free of `server-only`, like lib/maintenance/trash.ts, because
// server.ts imports this module (through lib/upload/sharex.ts and lib/upload/tus.ts)
// and the custom server is bundled by esbuild with `--packages=external`.
//
// `server-only` is not an installed package: it resolves ONLY inside Next's
// bundler, which aliases it, and inside vitest, which stubs it. esbuild passes
// the bare specifier through untouched, so `node dist/server.js` would die at
// link time with ERR_MODULE_NOT_FOUND — before server.listen(), i.e. a crash
// loop with no uploads, no panel and no media. Nothing in `tsc`, `vitest` or
// `next build` can see it, which is why scripts/check-server-bundle.mjs now
// fails the build instead.
//
// The guard buys nothing here anyway: this module imports @/lib/db, which would
// break a client bundle on its own.
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { folders } from "@/lib/db/schema";

/**
 * Which folder an upload asked to land in, and whether it is allowed to.
 *
 * Shared by BOTH upload paths on purpose. The browser (tus) and the API clients
 * (ShareX, the YTDL companion app) name a folder in completely different ways —
 * tus metadata versus a multipart field — but the question they are asking is
 * identical, and so is the answer that must not be got wrong: the id arrives as
 * a string the client wrote, so a forged UUID must never push a file into
 * somebody else's tree. Two copies of that check is one copy too many.
 */

/** Metadata / field key naming the drop target. */
export const FOLDER_KEY = "folderId";

/** Sentinel for "no folder", as opposed to an absent key ("use the default"). */
export const ROOT_FOLDER = "root";

/** Folder ids are `uuid` columns, so anything else must never reach Postgres. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shape check for any id that will be compared against a `uuid` column.
 *
 * Exported because lib/folders.ts needs exactly this rule for folder AND upload
 * ids: Postgres answers a malformed uuid with an error, so a query built from an
 * unchecked string turns "not a uuid" into a 500 while "not yours" is a quiet
 * miss — a difference a caller can measure. One regex, one answer.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Raised when a client names a folder it does not own (or that is gone). */
export class FolderAccessError extends Error {
  constructor(message = "Folder not found.") {
    super(message);
    this.name = "FolderAccessError";
  }
}

/**
 * Resolve a client-supplied folder id for `ownerId`.
 *
 * Three outcomes, and the difference between the first two matters:
 *
 *   `undefined` — the client expressed no preference. The account default
 *                 applies (that is `finalizeUpload`'s job), which is what every
 *                 ShareX upload has always done.
 *   `null`      — the client explicitly asked for "no folder", i.e. the root.
 *   `string`    — a folder this user owns.
 *
 * Throws `FolderAccessError` for anything else: an unknown id, another
 * account's id, and a malformed id are ONE answer on purpose. Telling them
 * apart would turn this into an oracle for "does folder X exist", which is a
 * slow directory listing of every folder on the server.
 */
export async function resolveFolderTarget(
  ownerId: string,
  raw: string | null | undefined,
): Promise<string | null | undefined> {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (raw === ROOT_FOLDER) return null;
  if (!UUID_RE.test(raw)) throw new FolderAccessError();

  const rows = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.id, raw), eq(folders.ownerId, ownerId)))
    .limit(1);

  if (!rows[0]) throw new FolderAccessError();
  return rows[0].id;
}

/** Same question, asked with a tus metadata bag. */
export async function resolveFolderFromMetadata(
  ownerId: string,
  metadata: Record<string, string | null> | undefined,
): Promise<string | null | undefined> {
  return resolveFolderTarget(ownerId, metadata?.[FOLDER_KEY] ?? undefined);
}
