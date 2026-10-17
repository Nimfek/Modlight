import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowLeft, Trash2 } from "lucide-react";
import { requireUser } from "@/lib/auth-helpers";
import { listUploads, kindOf } from "@/lib/data/uploads";
import { getUserPrefs } from "@/lib/data/user-prefs";
import { userBaseUrl } from "@/lib/media/urls";
import { TRASH_RETENTION_DAYS, trashDaysLeft } from "@/lib/maintenance/trash";
import { humanFileSize } from "@/lib/format";
import { trashTotalsFor } from "@/lib/uploads";
import { Button } from "@/components/ui/button";
import { TrashList, type TrashItem } from "@/components/dashboard/TrashList";

export default async function TrashPage() {
  const session = await requireUser();
  const user = session.user;
  const t = await getTranslations("dashboard.trash");

  // The tag is the identifier every trash-wide call is aimed by, and an account
  // without one has no trash this page can name. Guarded rather than passed as
  // "" so the totals query is skipped instead of refused.
  const tag = user.userCode ?? "";

  const [result, prefs, totals] = await Promise.all([
    listUploads({
      userId: user.id,
      trashed: true,
      perPage: 120,
      sort: "newest",
    }),
    getUserPrefs(user.id),
    // Counted over the whole trash, not over the page above: this list stops at
    // 120 and the header is the only place that says how much is really here.
    tag ? trashTotalsFor({ userId: user.id, email: user.email }, tag) : null,
  ]);

  // Thumbnails and restored-file links follow the hostname chosen in the
  // profile, so the trash doesn't show a different domain from the dashboard.
  const linkBase = userBaseUrl(prefs?.preferredDomain ?? null);

  // One clock for the whole page: every countdown is measured from the same
  // instant, on the server, so nothing drifts between SSR and hydration.
  const now = Date.now();

  const items: TrashItem[] = result.items.map((u) => ({
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
    // Trashed files keep their folder reference so a restore puts them back
    // where they were, but the trash view itself is flat — no tree, no name.
    folderId: u.folderId,
    folderName: null,
    expiresAt: u.expiresAt ? u.expiresAt.toISOString() : null,
    maxViews: u.maxViews ?? null,
    hasPassword: Boolean(u.passwordHash),
    daysLeft: trashDaysLeft(u.deletedAt, now),
  }));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Button variant="ghost" size="sm" asChild className="text-muted-foreground -ml-2 w-fit">
          <Link href="/dashboard">
            <ArrowLeft className="size-4" /> {t("backToFiles")}
          </Link>
        </Button>
        <div className="flex items-center gap-3">
          <div className="bg-destructive/10 text-destructive grid size-10 place-items-center rounded-lg">
            <Trash2 className="size-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("title")}</h1>
              {/* The list below stops at 120 rows; this is the only place that
                  says how much is really in here, and it is the same number the
                  confirmation will quote back. */}
              {totals && totals.files > 0 ? (
                <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[0.6875rem] font-medium tabular-nums">
                  {t("totals", { count: totals.files, size: humanFileSize(totals.bytes) })}
                </span>
              ) : null}
            </div>
            <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
          </div>
        </div>
      </div>

      <TrashList
        items={items}
        userCode={tag}
        appUrl={linkBase}
        retentionDays={TRASH_RETENTION_DAYS}
      />
    </div>
  );
}
