import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, Ban, Eye, HardDrive, ShieldCheck, Trash2 } from "lucide-react";
import { requireAdmin } from "@/lib/auth-helpers";
import { adminUserFiles } from "@/lib/data/admin-files";
import { FILE_KINDS, type FileKind, type SortKey } from "@/lib/data/uploads";
import { humanFileSize } from "@/lib/format";
import { isUnlimited } from "@/lib/quota";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TRASH_RETENTION_DAYS } from "@/lib/maintenance/trash";
import { AdminFileToolbar } from "@/components/admin/AdminFileToolbar";
import { FileGrid } from "@/components/dashboard/FileGrid";
import { FileList } from "@/components/dashboard/FileList";
import { TrashList } from "@/components/dashboard/TrashList";
import { Pagination } from "@/components/dashboard/Pagination";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("admin.files");
  return { title: t("pageTitle") };
}

const SORTS: SortKey[] = ["newest", "oldest", "largest", "smallest", "name", "views"];
const PER_PAGE_OPTIONS = [30, 60, 120];
const DEFAULT_PER_PAGE = 30;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * An administrator looking at somebody else's library.
 *
 * Three things make this different from the dashboard it reuses:
 *
 *  1. It is NOT impersonation. The signed-in account stays the administrator,
 *     so every write it performs is attributed to them in the audit log. That
 *     attribution is the entire reason Better Auth's impersonation was not used
 *     (see lib/data/admin-files.ts).
 *  2. The visit is recorded. `adminUserFiles` writes `admin.user.files_viewed`,
 *     deduplicated over ten minutes so paging does not bury the log.
 *  3. The file components run in `mode="admin"`, which drops the actions that
 *     are bound to the signed-in session (folders) and would otherwise report
 *     success after changing nothing.
 */
export default async function AdminUserFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const t = await getTranslations("admin.files");

  const page = Math.max(1, Number(first(sp.page)) || 1);
  const rawPer = Number(first(sp.per));
  const perPage = PER_PAGE_OPTIONS.includes(rawPer) ? rawPer : DEFAULT_PER_PAGE;
  const search = first(sp.search)?.trim() || undefined;
  const rawSort = first(sp.sort) as SortKey | undefined;
  const sort: SortKey = rawSort && SORTS.includes(rawSort) ? rawSort : "newest";
  const rawKind = first(sp.kind);
  const kind =
    rawKind && (FILE_KINDS as readonly string[]).includes(rawKind)
      ? (rawKind as FileKind)
      : undefined;
  const view = first(sp.view) === "list" ? "list" : "grid";
  const trashed = first(sp.trashed) === "1";

  const data = await adminUserFiles(session.user.id, id, {
    page,
    perPage,
    search,
    sort,
    kind,
    trashed,
  });
  if (!data) notFound();

  const { target, items } = data;
  const initials = (target.name?.trim() || target.email).slice(0, 2).toUpperCase();

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      <Link
        href="/dashboard/admin"
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-xs transition-colors"
      >
        <ArrowLeft className="size-3.5" /> {t("backToAdmin")}
      </Link>

      {/* Who is being looked at */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-10">
            {target.avatar ? <AvatarImage src={target.avatar} alt="" /> : null}
            <AvatarFallback className="text-sm">{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-heading truncate text-xl font-semibold tracking-tight">
                {target.name || target.email}
              </h1>
              {target.role === "admin" ? (
                <Badge className="gap-1 bg-violet-500/15 text-violet-500">
                  <ShieldCheck className="size-3" /> {t("roleAdmin")}
                </Badge>
              ) : null}
              {target.banned ? (
                <Badge variant="destructive" className="gap-1">
                  <Ban className="size-3" /> {t("banned")}
                </Badge>
              ) : null}
            </div>
            <p className="text-muted-foreground truncate text-sm">{target.email}</p>
          </div>
        </div>

        <div className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            <Eye className="size-3.5" /> {t("countFiles", { count: data.liveTotal })}
          </span>
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            <HardDrive className="size-3.5" />
            {humanFileSize(target.usedQuota)}
            {isUnlimited(target.maxQuota) ? " / ∞" : ` / ${humanFileSize(target.maxQuota)}`}
          </span>
          <code className="bg-muted text-foreground/80 rounded-md px-1.5 py-0.5 font-mono">
            /{target.tag}
          </code>
        </div>
      </div>

      {/* Standing notice. An administrator can already read any file; what was
          missing was saying so out loud and writing it down. */}
      <div className="ring-foreground/10 bg-muted/40 rounded-lg px-3 py-2 text-xs leading-relaxed ring-1">
        {t("banner", { name: target.name || target.email })}
      </div>

      <AdminFileToolbar
        search={search ?? ""}
        sort={sort}
        kind={kind ?? ""}
        view={view}
        trashed={trashed}
      />

      {items.length > 0 ? (
        <>
          {data.trashItems ? (
            /* The trash is a different place with different verbs. Drawing it
               with the ordinary file components gave links that 404 and a
               "move to trash" action on files already there, which only reset
               their thirty-day countdown. */
            <TrashList
              items={data.trashItems}
              userCode={target.tag}
              appUrl={target.linkBase}
              retentionDays={TRASH_RETENTION_DAYS}
            />
          ) : view === "list" ? (
            <FileList
              items={items}
              userCode={target.tag}
              appUrl={target.linkBase}
              copyRaw={target.copyRaw}
              mode="admin"
            />
          ) : (
            <FileGrid
              items={items}
              userCode={target.tag}
              appUrl={target.linkBase}
              copyRaw={target.copyRaw}
              mode="admin"
            />
          )}
          <Pagination total={data.total} page={data.page} perPage={data.perPage} />
        </>
      ) : (
        <div className="text-muted-foreground ring-foreground/10 flex flex-col items-center gap-2 rounded-xl px-6 py-16 text-center ring-1">
          <span className="bg-muted grid size-11 place-items-center rounded-full">
            <Trash2 className="size-5" />
          </span>
          <p className="text-foreground text-sm font-medium">
            {trashed ? t("emptyTrash") : search || kind ? t("emptyFiltered") : t("empty")}
          </p>
          <p className="text-xs">{t("emptyHint")}</p>
        </div>
      )}
    </div>
  );
}
