import "server-only";
import { and, desc, asc, eq, or, ilike, isNull, isNotNull, sql, inArray, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads } from "@/lib/db/schema";
import { descendantFolderIds } from "@/lib/data/folders";
import { effectiveType } from "@/lib/media/mime";
import {
  DEFAULT_PER_PAGE,
  FILE_KINDS,
  MAX_PAGE,
  MAX_PER_PAGE,
  type FileKind,
  type SortKey,
} from "@/lib/data/upload-query";
import type { FileItem } from "@/components/dashboard/types";

/**
 * The listing vocabulary now lives in lib/data/upload-query.ts, which is pure
 * and can therefore be shared with the HTTP surface that has to VALIDATE it
 * (app/api/uploads). Re-exported from here because every existing caller - the
 * dashboard, the admin file browser, the client-side toolbars - already looks
 * for it at this path.
 */
export {
  FILE_KINDS,
  SORT_KEYS,
  DEFAULT_PER_PAGE,
  MAX_PAGE,
  MAX_PER_PAGE,
} from "@/lib/data/upload-query";
export type { FileKind, SortKey } from "@/lib/data/upload-query";

const ARCHIVE_MIMES = [
  "application/zip",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/gzip",
  "application/x-tar",
];

const DOCUMENT_MIMES = [
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

/** Classify a stored row for display. Mirrors `kindFilter` below. */
export function kindOf(mimeType: string, kind: string, ext?: string | null): FileKind {
  if (kind === "paste") return "paste";
  // The extension is consulted only when the stored type says nothing (see
  // effectiveType): a .avif that ShareX labelled application/octet-stream is an
  // image, and filing it under "other" is what hid its thumbnail.
  const m = effectiveType(mimeType, ext);
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("text/") || DOCUMENT_MIMES.includes(m)) return "document";
  if (ARCHIVE_MIMES.includes(m)) return "archive";
  return "other";
}

/** SQL predicate for a file kind. */
function kindFilter(kind: FileKind): SQL | undefined {
  switch (kind) {
    case "image":
      return sql`${uploads.mimeType} like 'image/%'`;
    case "video":
      return sql`${uploads.mimeType} like 'video/%'`;
    case "audio":
      return sql`${uploads.mimeType} like 'audio/%'`;
    case "document":
      return or(
        sql`${uploads.mimeType} like 'text/%'`,
        inArray(uploads.mimeType, DOCUMENT_MIMES),
      );
    case "archive":
      return inArray(uploads.mimeType, ARCHIVE_MIMES);
    case "paste":
      return eq(uploads.kind, "paste");
    case "other":
      return and(
        sql`${uploads.mimeType} not like 'image/%'`,
        sql`${uploads.mimeType} not like 'video/%'`,
        sql`${uploads.mimeType} not like 'audio/%'`,
        sql`${uploads.mimeType} not like 'text/%'`,
        sql`${uploads.mimeType} not in ${[...DOCUMENT_MIMES, ...ARCHIVE_MIMES]}`,
      );
    default:
      return undefined;
  }
}

export interface ListParams {
  userId: string;
  page?: number;
  perPage?: number;
  search?: string;
  sort?: SortKey;
  trashed?: boolean;
  /** null = "no folder" (loose files); undefined = don't filter by folder. */
  folderId?: string | null;
  /** Include files in nested folders when a folder is selected. */
  includeSubfolders?: boolean;
  kind?: FileKind;
  visibility?: "public" | "private";
  minSize?: number;
  maxSize?: number;
  before?: Date;
  after?: Date;
}

function orderFor(sort: SortKey) {
  switch (sort) {
    case "oldest":
      return asc(uploads.createdAt);
    case "largest":
      return desc(uploads.size);
    case "smallest":
      return asc(uploads.size);
    case "name":
      return asc(uploads.filename);
    case "views":
      return desc(uploads.views);
    default:
      return desc(uploads.createdAt);
  }
}

/**
 * The page number `OFFSET` is computed from, bounded at both ends.
 *
 * Bounded HERE as well as in `parseUploadQuery` because two of this function's
 * callers never meet that parser: the dashboard and the admin file browser each
 * read `?page=` off the URL themselves. The offset below is the value Postgres
 * actually receives, so this is the last place that can keep it a number the
 * driver is able to serialise (see MAX_PAGE for what happens when it is not).
 *
 * NaN is worth spelling out rather than assuming away: `Math.max(1, NaN)` is
 * NaN and `Math.min(MAX_PAGE, NaN)` is NaN as well, so a clamp written the
 * obvious way hands it straight to `OFFSET NaN`. No caller can produce one today
 * - which is precisely why the guard belongs in the one place they all reach,
 * instead of in each of them.
 */
function pageOf(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(raw)));
}

export async function listUploads(params: ListParams) {
  const page = pageOf(params.page);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, params.perPage ?? DEFAULT_PER_PAGE));
  const sort = params.sort ?? "newest";

  const where: (SQL | undefined)[] = [
    eq(uploads.ownerId, params.userId),
    params.trashed ? isNotNull(uploads.deletedAt) : isNull(uploads.deletedAt),
  ];

  // Search covers the code as well as the filename: pasting a link's code
  // straight from the URL bar is the fastest way to find a specific file.
  if (params.search) {
    const q = `%${params.search}%`;
    where.push(or(ilike(uploads.filename, q), ilike(uploads.code, q)));
  }

  if (params.folderId === null) {
    where.push(isNull(uploads.folderId));
  } else if (params.folderId) {
    if (params.includeSubfolders) {
      const ids = await descendantFolderIds(params.userId, params.folderId);
      where.push(inArray(uploads.folderId, ids));
    } else {
      where.push(eq(uploads.folderId, params.folderId));
    }
  }

  if (params.kind) where.push(kindFilter(params.kind));
  if (params.visibility === "public") where.push(eq(uploads.published, true));
  if (params.visibility === "private") where.push(eq(uploads.published, false));
  if (params.minSize != null) where.push(sql`${uploads.size} >= ${params.minSize}`);
  if (params.maxSize != null) where.push(sql`${uploads.size} <= ${params.maxSize}`);
  if (params.after) where.push(sql`${uploads.createdAt} >= ${params.after}`);
  if (params.before) where.push(sql`${uploads.createdAt} <= ${params.before}`);

  const whereClause = and(...where.filter(Boolean));

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(uploads)
    .where(whereClause);

  const items = await db
    .select()
    .from(uploads)
    .where(whereClause)
    .orderBy(orderFor(sort))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return { items, total: Number(total), page, perPage };
}

/**
 * Map stored rows onto the plain shape the file views consume.
 *
 * Extracted from the dashboard page because the admin's read-only view of
 * somebody else's library renders the SAME components, and two copies of this
 * mapping would drift the moment a column is added: one view would quietly stop
 * showing padlocks or expiry badges, with nothing to fail.
 */
export function toFileItems(
  rows: (typeof uploads.$inferSelect)[],
  folderNames: Map<string, string>,
): FileItem[] {
  return rows.map((u) => ({
    id: u.id,
    code: u.code,
    filename: u.filename,
    ext: u.ext,
    mimeType: u.mimeType,
    size: Number(u.size),
    width: u.width,
    height: u.height,
    frames: u.frames,
    durationSeconds: u.durationSeconds,
    fps: u.fps,
    blurhash: u.blurhash,
    published: u.published,
    views: u.views,
    downloads: u.downloads,
    createdAt: u.createdAt.toISOString(),
    kind: kindOf(u.mimeType, u.kind, u.ext),
    folderId: u.folderId ?? null,
    folderName: u.folderId ? (folderNames.get(u.folderId) ?? null) : null,
    expiresAt: u.expiresAt ? u.expiresAt.toISOString() : null,
    maxViews: u.maxViews ?? null,
    hasPassword: Boolean(u.passwordHash),
  }));
}

export async function getUpload(id: string) {
  const rows = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function userStats(userId: string) {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      totalSize: sql<number>`coalesce(sum(${uploads.size}),0)::bigint`,
      totalViews: sql<number>`coalesce(sum(${uploads.views}),0)::int`,
    })
    .from(uploads)
    .where(and(eq(uploads.ownerId, userId), isNull(uploads.deletedAt)));
  return {
    count: Number(row?.count ?? 0),
    totalSize: Number(row?.totalSize ?? 0),
    totalViews: Number(row?.totalViews ?? 0),
  };
}

/** Per-kind counts for the sidebar's smart views. One pass over the table. */
export async function kindCounts(userId: string): Promise<Record<FileKind, number>> {
  const rows = await db
    .select({ mimeType: uploads.mimeType, kind: uploads.kind, n: sql<number>`count(*)::int` })
    .from(uploads)
    .where(and(eq(uploads.ownerId, userId), isNull(uploads.deletedAt)))
    .groupBy(uploads.mimeType, uploads.kind);

  const out = Object.fromEntries(FILE_KINDS.map((k) => [k, 0])) as Record<FileKind, number>;
  // No extension fallback here, deliberately: these counts label the sidebar's
  // smart views, and the views themselves are filtered by `kindFilter`, which is
  // SQL over mime_type alone. A count that disagreed with the list it opens
  // would be worse than a count that is occasionally conservative. The stored
  // types are what should be fixed (scripts/fix-mime-types.ts), not this sum.
  for (const r of rows) out[kindOf(r.mimeType, r.kind)] += Number(r.n);
  return out;
}
