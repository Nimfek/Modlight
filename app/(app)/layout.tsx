import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth-helpers";
import { AppShell, type ShellSidebarData } from "@/components/app-shell";
import { ThemeApplier } from "@/components/theme-applier";
import { TransfersProvider, type TransferFolder } from "@/components/transfers/TransfersProvider";
import { GlobalDropZone } from "@/components/transfers/GlobalDropZone";
import { TransferDock } from "@/components/transfers/TransferDock";
import { folderTree, type FolderNode } from "@/lib/data/folders";
import { kindCounts, userStats } from "@/lib/data/uploads";
import { getUserPrefs } from "@/lib/data/user-prefs";
import { backgroundStyle } from "@/lib/background";
import { avatarUrl } from "@/lib/avatar";
import { DuplicateReminderSlot } from "@/components/duplicates/DuplicateReminderSlot";
import type { FolderTreeNode } from "@/components/dashboard/FolderTree";

/** Drop the server-only fields (sortOrder, createdAt) before crossing to the client. */
function toTreeNodes(nodes: FolderNode[]): FolderTreeNode[] {
  return nodes.map((n) => ({
    id: n.id,
    parentId: n.parentId,
    name: n.name,
    slug: n.slug,
    isPublic: n.isPublic,
    count: n.count,
    totalCount: n.totalCount,
    children: toTreeNodes(n.children),
  }));
}

/** Flatten the tree to (id, name) pairs — all the drop target needs to label itself. */
function flattenFolders(nodes: FolderNode[], out: TransferFolder[] = []): TransferFolder[] {
  for (const node of nodes) {
    out.push({ id: node.id, name: node.name });
    flattenFolders(node.children, out);
  }
  return out;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireUser();

  const [tree, counts, stats, prefs, cookieStore] = await Promise.all([
    folderTree(session.user.id),
    kindCounts(session.user.id),
    userStats(session.user.id),
    // `defaultFolderId` is deliberately not part of the Better Auth session,
    // so the drop target reads it here rather than from session.user.
    getUserPrefs(session.user.id),
    cookies(),
  ]);

  // Every file lives in exactly one folder or none, so what the root folders
  // don't account for is precisely the loose pile.
  const inFolders = tree.reduce((sum, node) => sum + node.totalCount, 0);

  const sidebar: ShellSidebarData = {
    folders: toTreeNodes(tree),
    counts,
    totalFiles: stats.count,
    unsortedCount: Math.max(0, stats.count - inFolders),
    storage: { used: stats.totalSize, max: session.user.maxQuota ?? -1 },
  };

  return (
    <>
      <ThemeApplier
        theme={session.user.theme}
        background={backgroundStyle(prefs?.userCode, prefs?.backgroundKey, prefs?.backgroundDim)}
      />
      {/*
        The transfers provider wraps the whole panel so an upload outlives the
        page it started on: the queue, its progress and the floating dock all
        hang off one Uppy instance mounted here, not on /dashboard/upload.
      */}
      <TransfersProvider
        folders={flattenFolders(tree)}
        defaultFolderId={prefs?.defaultFolderId ?? null}
      >
        <AppShell
          user={{
            name: session.user.name,
            email: session.user.email,
            // `user.image` holds a storage key, not a URL (see lib/avatar.ts).
            // The shell is a client component and must never see one, so it is
            // resolved here, where the account's tag is already loaded.
            image: avatarUrl(prefs?.userCode ?? session.user.userCode, session.user.image),
            role: session.user.role,
            userCode: session.user.userCode,
          }}
          sidebar={sidebar}
          defaultCollapsed={cookieStore.get("ml_sidebar")?.value === "collapsed"}
        >
          {/*
            Mounted once, here, because the slot renders nothing on almost every
            load: a snooze cookie or a count under both thresholds answers it
            without a query, and the session it needs is already in hand. Per
            page it would be a second session lookup on every route.
          */}
          <DuplicateReminderSlot userId={session.user.id} />
          {children}
        </AppShell>
        <GlobalDropZone />
        <TransferDock />
      </TransfersProvider>
    </>
  );
}
