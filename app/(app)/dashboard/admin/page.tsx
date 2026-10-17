import {
  ShieldCheck,
  SlidersHorizontal,
  Users,
  BarChart3,
  Ghost,
  Wrench,
  Mail,
} from "lucide-react";
import { isNull, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { isRegistrationEnabled } from "@/lib/settings";
import { registrationKeyState } from "@/lib/registration";
import { loadMailSettings, toMailStatus } from "@/lib/mail-settings";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { serverStorageUsage } from "@/lib/data/admin";
import { uploads, user as users } from "@/lib/db/schema";
import { humanFileSize } from "@/lib/format";
import { isUnlimited } from "@/lib/quota";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsForm } from "@/components/admin/SettingsForm";
import { MailSettings } from "@/components/admin/MailSettings";
import { UserManager } from "@/components/admin/UserManager";
import { StatsCards, type GlobalStats } from "@/components/admin/StatsCards";
import { ReleaseChannel } from "@/components/admin/ReleaseChannel";
import { ServerDisk } from "@/components/admin/ServerDisk";
import { OrphanFiles } from "@/components/admin/OrphanFiles";
import { Maintenance } from "@/components/admin/Maintenance";

export const metadata = { title: "Admin" };

/**
 * Two aggregate queries instead of shipping the whole user table to the browser
 * to be counted there. `size` and the quota columns are bigint, so every sum is
 * read back through Number() rather than trusted as-is.
 *
 * The file aggregate is split by owner presence in one pass: orphans (owner
 * deleted, files kept) must not inflate "files stored", but the operator still
 * needs to see that they exist — a second scan of an 8.6k-row table just to
 * count them would be waste.
 */
async function loadGlobalStats(): Promise<GlobalStats> {
  const [[files], [accounts]] = await Promise.all([
    db
      .select({
        files: sql<number>`(count(*) filter (where ${uploads.ownerId} is not null))::int`,
        size: sql<string>`coalesce(sum(${uploads.size}) filter (where ${uploads.ownerId} is not null), 0)`,
        views: sql<number>`coalesce(sum(${uploads.views}), 0)::int`,
        orphanFiles: sql<number>`(count(*) filter (where ${uploads.ownerId} is null))::int`,
        orphanSize: sql<string>`coalesce(sum(${uploads.size}) filter (where ${uploads.ownerId} is null), 0)`,
      })
      .from(uploads)
      .where(isNull(uploads.deletedAt)),
    db
      .select({
        total: sql<number>`count(*)::int`,
        admins: sql<number>`(count(*) filter (where ${users.role} = 'admin'))::int`,
        banned: sql<number>`(count(*) filter (where ${users.banned}))::int`,
      })
      .from(users),
  ]);

  return {
    totalFiles: Number(files?.files ?? 0),
    totalStorage: humanFileSize(Number(files?.size ?? 0)),
    totalViews: Number(files?.views ?? 0),
    users: Number(accounts?.total ?? 0),
    admins: Number(accounts?.admins ?? 0),
    banned: Number(accounts?.banned ?? 0),
    orphanFiles: Number(files?.orphanFiles ?? 0),
    orphanStorage: humanFileSize(Number(files?.orphanSize ?? 0)),
  };
}

export default async function AdminPage() {
  const session = await requireAdmin();
  const t = await getTranslations("admin");
  const [regEnabled, keyState, mail, stats, disk] = await Promise.all([
    isRegistrationEnabled(),
    registrationKeyState(),
    // Read through rather than from the 30 s snapshot: an operator who has just
    // saved SMTP settings must not be shown the previous ones.
    loadMailSettings(true).then(toMailStatus),
    loadGlobalStats(),
    serverStorageUsage(),
  ]);
  const defaultQuota = isUnlimited(config.defaultUserQuota)
    ? null
    : humanFileSize(config.defaultUserQuota);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="bg-primary/10 text-primary grid size-10 shrink-0 place-items-center rounded-xl">
            <ShieldCheck className="size-5" />
          </span>
          <div>
            <h1 className="font-heading text-xl font-semibold tracking-tight">
              {t("title")}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t("intro")}
            </p>
          </div>
        </div>
        <Badge variant="outline" className="text-muted-foreground hidden sm:inline-flex">
          {t("signedInAs", { email: session.user.email })}
        </Badge>
      </div>

      {/* Five sections, in the order an operator works through them: look at the
          install, then the people on it, then the mess, then the knobs, then the
          jobs. Each tab's content mounts on activation, so the heavy ones
          (orphan listing, maintenance) cost nothing until asked for. */}
      <Tabs defaultValue="overview" className="gap-6">
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="bg-muted/60 h-9 w-max justify-start">
            <TabsTrigger value="overview" className="gap-1.5 px-3">
              <BarChart3 className="size-4" /> {t("tabs.overview")}
            </TabsTrigger>
            <TabsTrigger value="users" className="gap-1.5 px-3">
              <Users className="size-4" /> {t("tabs.users")}
            </TabsTrigger>
            <TabsTrigger value="orphans" className="gap-1.5 px-3">
              <Ghost className="size-4" /> {t("tabs.orphans")}
              {stats.orphanFiles > 0 ? (
                <span className="bg-amber-500/15 text-amber-600 dark:text-amber-400 ml-0.5 rounded-full px-1.5 py-px text-[0.65rem] font-medium tabular-nums">
                  {stats.orphanFiles}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="settings" className="gap-1.5 px-3">
              <SlidersHorizontal className="size-4" /> {t("tabs.settings")}
            </TabsTrigger>
            <TabsTrigger value="mail" className="gap-1.5 px-3">
              <Mail className="size-4" /> {t("tabs.mail")}
              {/* An install with no outgoing mail cannot reset a password or
                  confirm an address, and the operator should hear that from the
                  application rather than from a stuck user. */}
              {!mail.ready ? (
                <span className="ml-0.5 rounded-full bg-amber-500/15 px-1.5 py-px text-[0.65rem] font-medium text-amber-600 dark:text-amber-400">
                  {t("mail.offBadge")}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="maintenance" className="gap-1.5 px-3">
              <Wrench className="size-4" /> {t("tabs.maintenance")}
            </TabsTrigger>
          </TabsList>
        </div>

        {/* The machine comes first, above the per-account tiles: an account over
            its quota is that account's problem, a full disk is everyone's. */}
        <TabsContent value="overview" className="flex flex-col gap-4">
          <ServerDisk usage={disk} />
          <StatsCards stats={stats} />
        </TabsContent>

        <TabsContent value="users">
          <UserManager currentUserId={session.user.id} mailReady={mail.ready} />
        </TabsContent>

        <TabsContent value="orphans">
          <OrphanFiles />
        </TabsContent>

        <TabsContent value="settings">
          <SettingsForm
            registration={{ enabled: regEnabled, keyState }}
            defaultQuota={defaultQuota}
          />
        </TabsContent>

        <TabsContent value="mail">
          <MailSettings initial={mail} adminEmail={session.user.email} />
        </TabsContent>

        <TabsContent value="maintenance" className="flex flex-col gap-4">
          <ReleaseChannel />
          <Maintenance />
        </TabsContent>
      </Tabs>
    </div>
  );
}
