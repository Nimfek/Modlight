import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ExternalLink, Globe } from "lucide-react";
import { requireUser } from "@/lib/auth-helpers";
import {
  FILE_KINDS,
  kindCounts,
  kindOf,
  listUploads,
  type FileKind,
  type SortKey,
} from "@/lib/data/uploads";
import { folderPath, listUserFolders } from "@/lib/data/folders";
import { getUserPrefs } from "@/lib/data/user-prefs";
import { userBaseUrl } from "@/lib/media/urls";
import { Toolbar } from "@/components/dashboard/Toolbar";
import { FileGrid } from "@/components/dashboard/FileGrid";
import { FileList } from "@/components/dashboard/FileList";
import { Pagination } from "@/components/dashboard/Pagination";
import { EmptyState } from "@/components/dashboard/EmptyState";
import type { FileItem } from "@/components/dashboard/types";

const SORTS: SortKey[] = ["newest", "oldest", "largest", "smallest", "name", "views"];

/**
 * Minimum-size presets. Kept here rather than imported from the (client)
 * Toolbar: a server component can't read plain values out of a "use client"
 * module — it would receive a client reference instead of the object.
 */
const SIZE_PRESETS: Record<string, number> = {
  "10mb": 10 * 1024 * 1024,
  "100mb": 100 * 1024 * 1024,
  "1gb": 1024 * 1024 * 1024,
};

const PER_PAGE_OPTIONS = [30, 60, 120];
const DEFAULT_PER_PAGE = 30;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Parse a YYYY-MM-DD (or full ISO) parameter; undefined when unusable. */
function parseDay(value: string | undefined, endOfDay = false): Date | undefined {
  if (!value) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) d.setHours(23, 59, 59, 999);
  return d;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const session = await requireUser();
  const user = session.user;

  // The library is one page with many filters, so the folder list is needed no
  // matter what — fetched first because it also decides the landing view.
  const allFolders = await listUserFolders(user.id);

  /**
   * Someone who organises their uploads should not be dropped into 6800 loose
   * files. A bare /dashboard therefore opens the folder explorer — but only for
   * accounts that actually have folders, so a fresh (or deliberately flat)
   * library still lands straight on its files. Any query string at all means
   * the user asked for this list explicitly ("All files" links carry ?all=1),
   * so filters, folders and paging are never intercepted.
   */
  if (Object.keys(sp).length === 0 && allFolders.length > 0) {
    redirect("/dashboard/folders");
  }

  const [t, tNav] = await Promise.all([getTranslations("dashboard"), getTranslations("nav")]);

  // ---- URL → query -------------------------------------------------------
  const page = Math.max(1, Number(first(sp.page)) || 1);
  const rawPer = Number(first(sp.per));
  const perPage = PER_PAGE_OPTIONS.includes(rawPer) ? rawPer : DEFAULT_PER_PAGE;
  const search = first(sp.search)?.trim() || undefined;

  const rawSort = first(sp.sort) as SortKey | undefined;
  const sort: SortKey = rawSort && SORTS.includes(rawSort) ? rawSort : "newest";
  const view = first(sp.view) === "list" ? "list" : "grid";

  const rawFolder = first(sp.folder);
  // "none" is the explicit "files that live in no folder" view; anything else
  // is a folder id, and `undefined` means "everything, wherever it lives".
  const folderId = rawFolder === "none" ? null : rawFolder || undefined;
  const includeSubfolders = first(sp.sub) === "1";

  const rawKind = first(sp.kind);
  const kind = rawKind && (FILE_KINDS as string[]).includes(rawKind) ? (rawKind as FileKind) : undefined;

  const rawVisibility = first(sp.visibility);
  const visibility =
    rawVisibility === "public" || rawVisibility === "private" ? rawVisibility : undefined;

  const rawSize = first(sp.size);
  const minSize = rawSize ? SIZE_PRESETS[rawSize] : undefined;

  const rawAfter = first(sp.after);
  const rawBefore = first(sp.before);
  const after = parseDay(rawAfter);
  const before = parseDay(rawBefore, true);

  // ---- Data --------------------------------------------------------------
  const [counts, result, breadcrumb, prefs] = await Promise.all([
    kindCounts(user.id),
    listUploads({
      userId: user.id,
      page,
      perPage,
      search,
      sort,
      folderId,
      includeSubfolders,
      kind,
      visibility,
      minSize,
      after,
      before,
    }),
    folderId ? folderPath(user.id, folderId) : Promise.resolve([]),
    getUserPrefs(user.id),
  ]);

  // Every link copied out of the dashboard uses the hostname the user picked in
  // their profile, so the clipboard agrees with what ShareX produces.
  const linkBase = userBaseUrl(prefs?.preferredDomain ?? null);

  const currentFolder = folderId ? allFolders.find((f) => f.id === folderId) : undefined;
  const folderNames = new Map(allFolders.map((f) => [f.id, f.name]));

  const items: FileItem[] = result.items.map((u) => ({
    id: u.id,
    code: u.code,
    filename: u.filename,
    ext: u.ext,
    mimeType: u.mimeType,
    size: Number(u.size),
    width: u.width,
    height: u.height,
    frames: u.frames,
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

  const filtering = Boolean(search || kind || visibility || minSize || after || before);
  const hasResults = items.length > 0;
  const userCode = user.userCode ?? "";
  const copyRaw = user.copyRaw ?? false;

  // ---- Heading -----------------------------------------------------------
  const title = currentFolder
    ? currentFolder.name
    : folderId === null
      ? t("folders.unsorted")
      : kind
        ? tNav(`kind.${kind}`)
        : t("yourFiles");

  const subtitle = currentFolder
    ? t("scope.inFolder", { name: currentFolder.name })
    : folderId === null
      ? t("scope.unsorted")
      : kind
        ? t("scope.kind", { kind: tNav(`kind.${kind}`) })
        : t("yourFilesDesc");

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      {/* Location */}
      <div className="flex flex-col gap-2">
        {breadcrumb.length > 0 || folderId === null ? (
          <nav
            aria-label={t("breadcrumbAria")}
            className="flex flex-wrap items-center gap-1.5 text-xs"
          >
            <Link
              href="/dashboard?all=1"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("yourFiles")}
            </Link>
            {/* Inside a folder the trail also leads back up to the explorer,
                so the two views are never a one-way trip. */}
            {breadcrumb.length > 0 ? (
              <>
                <span className="text-muted-foreground/40">/</span>
                <Link
                  href="/dashboard/folders"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  {tNav("folders")}
                </Link>
              </>
            ) : null}
            {folderId === null ? (
              <>
                <span className="text-muted-foreground/40">/</span>
                <span className="text-foreground font-medium">{t("folders.unsorted")}</span>
              </>
            ) : (
              breadcrumb.map((crumb, i) => (
                <span key={crumb.id} className="flex items-center gap-1.5">
                  <span className="text-muted-foreground/40">/</span>
                  {i === breadcrumb.length - 1 ? (
                    <span className="text-foreground font-medium">{crumb.name}</span>
                  ) : (
                    <Link
                      href={`/dashboard?folder=${crumb.id}`}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {crumb.name}
                    </Link>
                  )}
                </span>
              ))
            )}
          </nav>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
          <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
            {t("countFiles", { count: result.total })}
          </span>

          {currentFolder?.isPublic ? (
            <Link
              href={`/a/${userCode}/${currentFolder.slug}`}
              target="_blank"
              rel="noreferrer"
              className="bg-primary/10 text-primary ring-primary/20 hover:bg-primary/15 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 transition-colors"
            >
              <Globe className="size-3" />
              {t("folders.publicBadge")}
              <ExternalLink className="size-3 opacity-70" />
            </Link>
          ) : null}
        </div>

        <p className="text-muted-foreground text-sm">{subtitle}</p>
      </div>

      <Toolbar
        search={search ?? ""}
        sort={sort}
        view={view}
        kind={kind ?? ""}
        visibility={visibility ?? ""}
        size={rawSize ?? ""}
        after={rawAfter ?? ""}
        before={rawBefore ?? ""}
        counts={counts}
        folderActive={Boolean(folderId)}
        includeSubfolders={includeSubfolders}
      />

      {hasResults ? (
        <>
          {view === "list" ? (
            <FileList
              items={items}
              userCode={userCode}
              appUrl={linkBase}
              copyRaw={copyRaw}
              currentFolderId={folderId ?? null}
            />
          ) : (
            <FileGrid
              items={items}
              userCode={userCode}
              appUrl={linkBase}
              copyRaw={copyRaw}
              currentFolderId={folderId ?? null}
            />
          )}
          <Pagination total={result.total} page={result.page} perPage={result.perPage} />
        </>
      ) : (
        <EmptyState
          mode={filtering ? "filtered" : currentFolder ? "folder" : "empty"}
          folderName={currentFolder?.name}
          clearHref={currentFolder ? `/dashboard?folder=${currentFolder.id}` : "/dashboard?all=1"}
        />
      )}
    </div>
  );
}
