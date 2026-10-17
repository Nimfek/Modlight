import "server-only";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, folders, uploads, user as users } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { listUploads, toFileItems, type FileKind, type SortKey } from "@/lib/data/uploads";
import { trashDaysLeft } from "@/lib/maintenance/trash";
import { userBaseUrl } from "@/lib/media/urls";
import { avatarUrl } from "@/lib/avatar";
import type { FileItem } from "@/components/dashboard/types";
import type { TrashItem } from "@/components/dashboard/TrashList";

/**
 * An administrator looking at somebody else's library.
 *
 * Explicitly NOT impersonation, although Better Auth ships it. Three reasons,
 * and the first is the one that matters:
 *
 *  1. **Attribution.** With a session that says "you are Bob", every write
 *     lands in the audit log as Bob deleting his own file. The one question
 *     an administrative action has to be able to answer afterwards is "who did
 *     this", and impersonation deletes the answer.
 *  2. **Scope.** Reviewing files needs read access to files. Impersonation also
 *     hands over ShareX tokens, the password form and the 2FA settings, none of
 *     which this is for.
 *  3. **Exit.** A real session cookie for another account makes "I forgot to
 *     leave" a silent state that behaves normally until it does not.
 *
 * No new authority is granted here either: an administrator can already read
 * any file (lib/media/serve.ts treats them as a privileged viewer) and act on
 * any upload (`ownedUpload` in app/actions/uploads.ts). What was missing was a
 * place to do it deliberately, and a record that it happened.
 */

/** How long one recorded visit covers, so paging does not spam the log. */
const VIEW_DEDUP_MS = 10 * 60 * 1000;

export interface AdminFileTarget {
  id: string;
  name: string;
  email: string;
  /** `user_code`: the first segment of this account's public links. */
  tag: string;
  /** Resolved avatar URL, or null when this account still shows initials. */
  avatar: string | null;
  role: string | null;
  banned: boolean;
  /** Base URL THIS user's links are generated with, not the admin's. */
  linkBase: string;
  copyRaw: boolean;
  usedQuota: number;
  maxQuota: number;
}

export interface AdminFilesView {
  target: AdminFileTarget;
  items: FileItem[];
  /**
   * The same rows carrying their purge countdown, in trash mode only.
   *
   * A trashed row cannot be drawn with the ordinary file components: their
   * links point at `/{tag}/{code}`, which is a 404 for anything soft-deleted,
   * and their menu offers "move to trash" — on a file already in it, which just
   * rewrites `deleted_at` and quietly grants it another thirty days of life.
   * The trash needs the two actions the trash has: restore, and destroy.
   */
  trashItems: TrashItem[] | null;
  total: number;
  page: number;
  perPage: number;
  /**
   * Files the account holds outside the trash, ignoring the current filter.
   *
   * The header states how big somebody's library is, and `total` is the size of
   * the current RESULT — so searching for "cat" made the header claim the
   * account owned three files.
   */
  liveTotal: number;
}

export interface AdminFilesParams {
  page?: number;
  perPage?: number;
  search?: string;
  sort?: SortKey;
  kind?: FileKind;
  trashed?: boolean;
}

async function loadTarget(userId: string): Promise<AdminFileTarget | null> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      tag: users.userCode,
      image: users.image,
      role: users.role,
      banned: users.banned,
      preferredDomain: users.preferredDomain,
      copyRaw: users.copyRaw,
      usedQuota: users.usedQuota,
      maxQuota: users.maxQuota,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    tag: row.tag ?? "",
    avatar: avatarUrl(row.tag, row.image),
    role: row.role ?? null,
    banned: row.banned ?? false,
    // The owner's own domain, so a link copied out of this view is the link the
    // owner sees and hands out, not one rewritten to the admin's preference.
    linkBase: userBaseUrl(row.preferredDomain ?? null),
    copyRaw: row.copyRaw ?? false,
    usedQuota: Number(row.usedQuota ?? 0),
    maxQuota: Number(row.maxQuota ?? -1),
  };
}

/**
 * Log the visit, but not once per page of results.
 *
 * An administrator paging through 8000 files would otherwise write a hundred
 * identical rows, and a log nobody can skim is a log nobody reads. One entry
 * per admin, per subject, per ten minutes keeps the fact recorded and the log
 * legible.
 */
async function recordVisit(adminId: string, target: AdminFileTarget): Promise<void> {
  const since = new Date(Date.now() - VIEW_DEDUP_MS);
  const [recent] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, adminId),
        eq(auditLog.action, "admin.user.files_viewed"),
        gt(auditLog.createdAt, since),
        sql`${auditLog.detail} ->> 'targetUserId' = ${target.id}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (recent) return;

  await recordAudit(adminId, "admin.user.files_viewed", {
    by: adminId,
    targetUserId: target.id,
    targetEmail: target.email,
  });
}

/**
 * Everything the admin file browser needs, in one call.
 *
 * The caller is responsible for having established that `adminId` is an
 * administrator (`requireAdmin`); this function assumes it and records the
 * access on that basis.
 */
export async function adminUserFiles(
  adminId: string,
  targetId: string,
  params: AdminFilesParams = {},
): Promise<AdminFilesView | null> {
  const target = await loadTarget(targetId);
  if (!target) return null;

  await recordVisit(adminId, target);

  const result = await listUploads({
    userId: targetId,
    page: params.page,
    perPage: params.perPage,
    search: params.search,
    sort: params.sort,
    kind: params.kind,
    trashed: params.trashed,
  });

  // The owner's folder names, so a file's chip reads the same as it does for
  // them. Folder ACTIONS stay out of this view (see the `mode` prop on the file
  // components): every one of them is scoped to the session user, so a "move to
  // folder" button here would update zero rows and report success.
  const owned = await db
    .select({ id: folders.id, name: folders.name })
    .from(folders)
    .where(eq(folders.ownerId, targetId));
  const folderNames = new Map(owned.map((f) => [f.id, f.name]));

  const [live] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(uploads)
    .where(and(eq(uploads.ownerId, targetId), isNull(uploads.deletedAt)));

  const items = toFileItems(result.items, folderNames);

  // Zipped by index rather than looked up: `toFileItems` preserves order and
  // the countdown belongs to the row it came from.
  const now = Date.now();
  const trashItems: TrashItem[] | null = params.trashed
    ? items.map((item, i) => ({
        ...item,
        daysLeft: trashDaysLeft(result.items[i]?.deletedAt ?? null, now),
      }))
    : null;

  return {
    target,
    items,
    trashItems,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
    liveTotal: Number(live?.n ?? 0),
  };
}
