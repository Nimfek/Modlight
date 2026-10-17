import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ExternalLink, FileStack, Globe, UploadCloud } from "lucide-react";
import { requireUser } from "@/lib/auth-helpers";
import { buildFolderTree, folderPath, listUserFolders, unfiledStats } from "@/lib/data/folders";
import type { FolderNode } from "@/lib/data/folders";
import { Button } from "@/components/ui/button";
import { FolderBrowser } from "@/components/dashboard/FolderBrowser";
import type { BrowserFolder } from "@/components/dashboard/FolderCard";

/** Folders nested under `node`, at any depth. */
function countDescendants(node: FolderNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

/** Drop the tree/server-only fields before the data crosses to the client. */
function toBrowserFolder(node: FolderNode): BrowserFolder {
  return {
    id: node.id,
    name: node.name,
    slug: node.slug,
    isPublic: node.isPublic,
    directCount: node.count,
    fileCount: node.totalCount,
    size: node.totalSize,
    subfolderCount: node.children.length,
    descendantCount: countDescendants(node),
  };
}

function findNode(nodes: FolderNode[], id: string): FolderNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The folder explorer — the view someone who organises their library actually
 * wants to open first. It shows folders as tiles (name, file count, size),
 * never the flat file list; that still lives at /dashboard and is reachable
 * from here in one click.
 */
export default async function FoldersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const session = await requireUser();
  const user = session.user;
  const [t, tNav] = await Promise.all([
    getTranslations("dashboard.folderBrowser"),
    getTranslations("nav"),
  ]);

  const folderId = first(sp.folder) || null;

  const [rows, breadcrumb, unsorted] = await Promise.all([
    listUserFolders(user.id),
    folderId ? folderPath(user.id, folderId) : Promise.resolve([]),
    folderId ? Promise.resolve(null) : unfiledStats(user.id),
  ]);

  const tree = buildFolderTree(rows);
  const current = folderId ? findNode(tree, folderId) : undefined;
  if (folderId && !current) notFound();

  const children = (current ? current.children : tree).map(toBrowserFolder);
  const userCode = user.userCode ?? "";

  const totalFolders = rows.length;
  const filesHere = current ? { count: current.count, size: current.size } : null;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
      {/* Location */}
      <div className="flex flex-col gap-2">
        <nav aria-label={t("breadcrumbAria")} className="flex flex-wrap items-center gap-1.5 text-xs">
          {current ? (
            <Link
              href="/dashboard/folders"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("title")}
            </Link>
          ) : (
            <span className="text-foreground font-medium">{t("title")}</span>
          )}
          {breadcrumb.map((crumb, i) => (
            <span key={crumb.id} className="flex items-center gap-1.5">
              <span className="text-muted-foreground/40">/</span>
              {i === breadcrumb.length - 1 ? (
                <span className="text-foreground font-medium">{crumb.name}</span>
              ) : (
                <Link
                  href={`/dashboard/folders?folder=${crumb.id}`}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  {crumb.name}
                </Link>
              )}
            </span>
          ))}
        </nav>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {current ? current.name : t("title")}
          </h1>
          <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
            {t("countFolders", { count: children.length })}
          </span>

          {current?.isPublic && userCode ? (
            <Link
              href={`/a/${userCode}/${current.slug}`}
              target="_blank"
              rel="noreferrer"
              className="bg-primary/10 text-primary ring-primary/20 hover:bg-primary/15 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 transition-colors"
            >
              <Globe className="size-3" />
              {t("public")}
              <ExternalLink className="size-3 opacity-70" />
            </Link>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground text-sm">
            {current
              ? t("subtitleInside", { name: current.name })
              : totalFolders > 0
                ? t("subtitle")
                : t("subtitleEmpty")}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={current ? `/dashboard?folder=${current.id}` : "/dashboard?all=1"}>
                <FileStack className="size-4" />
                {current ? t("showFiles") : tNav("files")}
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/dashboard/upload">
                <UploadCloud className="size-4" />
                {tNav("upload")}
              </Link>
            </Button>
          </div>
        </div>
      </div>

      <FolderBrowser
        folders={children}
        currentFolderId={current?.id ?? null}
        currentFolderName={current?.name ?? null}
        filesHere={filesHere}
        unsorted={unsorted}
        userCode={userCode}
      />
    </div>
  );
}
