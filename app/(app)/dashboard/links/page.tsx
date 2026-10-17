import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { listShortLinks } from "@/app/actions/shortlinks";
import { config } from "@/lib/config";
import { requireUser } from "@/lib/auth-helpers";
import { getUserPrefs, mayCreateRootShortLink } from "@/lib/data/user-prefs";
import { LinkManager } from "@/components/links/LinkManager";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("links");
  return {
    title: t("metaTitle"),
  };
}

export default async function LinksPage() {
  const t = await getTranslations("links");
  const session = await requireUser();
  const [rows, prefs] = await Promise.all([listShortLinks(), getUserPrefs(session.user.id)]);

  // Serialize dates for the client component.
  const links = rows.map((l) => ({
    id: l.id,
    code: l.code,
    target: l.target,
    clicks: l.clicks,
    // Map the hash to a boolean — never expose the password hash to the client.
    hasPassword: Boolean(l.passwordHash),
    lastUsedAt: l.lastUsedAt ? l.lastUsedAt.toISOString() : null,
    expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null,
    createdAt: l.createdAt.toISOString(),
  }));

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          {t("pageTitle")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("pageDescription", { appName: config.appName })}
        </p>
      </header>

      <LinkManager
        links={links}
        appUrl={config.appUrl}
        shortBase={config.shortUrl}
        userCode={prefs?.userCode ?? null}
        canUseRoot={prefs ? mayCreateRootShortLink(prefs) : false}
      />
    </div>
  );
}
