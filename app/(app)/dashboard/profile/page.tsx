import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth-helpers";
import { config } from "@/lib/config";
import { userStats } from "@/lib/data/uploads";
import { folderTree, type FolderNode } from "@/lib/data/folders";
import { getUserPrefs } from "@/lib/data/user-prefs";
import { listMySessions } from "@/lib/data/sessions";
import { DEFAULT_THEME } from "@/lib/themes";
import { myUrlPrefs } from "@/app/actions/account";
import { ProfileForm } from "@/components/profile/ProfileForm";
import { SecuritySection } from "@/components/profile/SecuritySection";
import { SessionList } from "@/components/profile/SessionList";
import { QuotaCard } from "@/components/profile/QuotaCard";
import { AppearanceSection } from "@/components/profile/AppearanceSection";
import { DuplicatesSection } from "@/components/profile/DuplicatesSection";
import { BackgroundSection } from "@/components/profile/BackgroundSection";
import { AvatarSection } from "@/components/profile/AvatarSection";
import { backgroundUrl, DIM_DEFAULT } from "@/lib/background";
import { avatarUrl } from "@/lib/avatar";
import { NamingSection } from "@/components/profile/NamingSection";
import { DomainSection } from "@/components/profile/DomainSection";
import {
  TagSection,
  DefaultFolderSection,
  type FolderOption,
} from "@/components/profile/TagSection";

export const metadata = { title: "Profile" };

/** Depth-first flatten so the select can indent nested folders. */
function flattenFolders(nodes: FolderNode[], depth = 0): FolderOption[] {
  return nodes.flatMap((n) => [
    { id: n.id, name: n.name, depth },
    ...flattenFolders(n.children, depth + 1),
  ]);
}

/**
 * One labelled band of settings.
 *
 * The cards inside sit in a two-column grid on wide viewports and collapse to
 * one below that. Grid items stretch by default, so two cards sharing a row end
 * up the same height — the reason this is a grid and not a column of cards is
 * exactly that: the page used to be a single tall stack with the whole right
 * half of the screen empty.
 */
function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          {title}
        </h2>
        <span aria-hidden className="bg-foreground/10 h-px flex-1" />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">{children}</div>
    </section>
  );
}

export default async function ProfilePage() {
  const session = await requireUser();
  const t = await getTranslations("profile");
  const u = session.user;

  // `skipTagInUrl` / `defaultFolderId` are not part of Better Auth's session
  // payload, so they are read straight from the row.
  const [stats, prefs, tree, urlPrefs, sessions] = await Promise.all([
    userStats(u.id),
    getUserPrefs(u.id),
    folderTree(u.id),
    myUrlPrefs(),
    // Read on every load rather than cached: a list of live sessions that is a
    // minute stale is a list that can show a session somebody just revoked.
    listMySessions(),
  ]);

  // Previews are built from the hostname this account actually publishes on, so
  // the tag/naming cards show the real link rather than the deployment default.
  const tag = prefs?.userCode ?? u.userCode ?? null;
  const linkTag = prefs?.skipTagInUrl ? null : tag;

  return (
    <div className="mx-auto w-full max-w-[90rem] space-y-8">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("pageTitle")}</h1>
        <p className="text-muted-foreground text-sm">{t("pageIntro")}</p>
      </header>

      {/* Who you are + what you are using. */}
      <SettingsGroup title={t("groups.account")}>
        <ProfileForm
          defaults={{
            name: u.name ?? "",
            email: u.email,
            userCode: u.userCode ?? null,
            hideUploads: Boolean(u.hideUploads),
            copyRaw: Boolean(u.copyRaw),
          }}
        />

        <QuotaCard
          usedQuota={u.usedQuota ?? 0}
          maxQuota={u.maxQuota ?? -1}
          totalSize={stats.totalSize}
          fileCount={stats.count}
          totalViews={stats.totalViews}
        />

        {/* Full width: it renders a list, not a form. Nothing runs until the
            owner presses Scan, so this costs the page no queries on load. */}
        <DuplicatesSection />
      </SettingsGroup>

      {/* Everything that shapes a share link, in the order it appears in one:
          host / tag / file name — plus where the file itself lands. */}
      <SettingsGroup title={t("groups.links")}>
        <TagSection
          appUrl={urlPrefs.baseUrl}
          tag={tag}
          isAdmin={u.role === "admin"}
          skipTagInUrl={prefs?.skipTagInUrl ?? false}
        />

        <NamingSection
          baseUrl={urlPrefs.baseUrl}
          tag={linkTag}
          scheme={urlPrefs.scheme}
          pattern={urlPrefs.pattern}
          wordCount={urlPrefs.wordCount}
          randomLength={urlPrefs.randomLength}
        />

        {/* Renders nothing when the deployment answers on a single hostname —
            the grid simply flows the next card into its place. */}
        <DomainSection
          domains={config.appDomains}
          defaultDomain={config.appUrl}
          preferredDomain={urlPrefs.preferredDomain}
          tag={linkTag}
        />

        <DefaultFolderSection
          folders={flattenFolders(tree)}
          defaultFolderId={prefs?.defaultFolderId ?? null}
        />
      </SettingsGroup>

      {/* Appearance is owned by the theming work; it keeps its slot here. */}
      <SettingsGroup title={t("groups.personal")}>
        <AvatarSection
          url={avatarUrl(prefs?.userCode ?? u.userCode, u.image)}
          initials={(u.name || u.email).slice(0, 2).toUpperCase()}
        />

        <AppearanceSection theme={u.theme ?? DEFAULT_THEME} locale={u.locale ?? null} />

        <BackgroundSection
          url={backgroundUrl(prefs?.userCode, prefs?.backgroundKey)}
          dim={prefs?.backgroundDim ?? DIM_DEFAULT}
        />

        <SecuritySection
          twoFactorEnabled={Boolean(u.twoFactorEnabled)}
          emailVerified={Boolean(u.emailVerified)}
        />

        {/* Full width: one row per session, and the rows carry long strings
            (the raw User-Agent) that a half-width card would only truncate. */}
        <SessionList sessions={sessions} />
      </SettingsGroup>
    </div>
  );
}
