import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth-helpers";
import { myTokens } from "@/app/actions/tokens";
import { myUrlPrefs } from "@/app/actions/account";
import { config } from "@/lib/config";
import { TokenManager } from "@/components/tokens/TokenManager";
import { SetupGuide } from "@/components/tokens/SetupGuide";
import { OneClickShareX } from "@/components/tokens/OneClickShareX";
import { AppCard } from "@/components/tokens/AppCard";

export const metadata: Metadata = {
  title: "Integrations",
};

export default async function TokensPage() {
  const session = await requireUser();
  const t = await getTranslations("tokens");
  const [rows, urlPrefs] = await Promise.all([myTokens(), myUrlPrefs()]);

  // Everything generated on this page — the .sxcu RequestURL, the curl snippets,
  // the bash uploader — points at the hostname the user chose in their profile,
  // so what ShareX posts to matches the links it gets back.
  const appUrl = urlPrefs.baseUrl;
  const multiDomain = config.appDomains.length > 1;

  // Strip secrets — never ship tokenHash to the client.
  const tokens = rows.map((t) => ({
    id: t.id,
    name: t.name,
    scope: t.scope,
    preview: t.preview,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
  }));

  // A friendly handle for naming the downloaded .sxcu file.
  const username =
    session.user.name?.split(" ")[0] ||
    session.user.email.split("@")[0] ||
    session.user.userCode ||
    "user";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          {t("pageTitle")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("pageIntro", { appName: config.appName })}
        </p>
      </header>

      {/* Our own client first, ShareX second.
          ShareX stays fully supported — it is what these accounts use today and
          nothing about it breaks. But it is no longer the headline: somebody
          arriving here should install our app, sign in, and be done, and the
          order of the page is the clearest way to say that. */}
      <AppCard />

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="font-heading text-lg font-semibold tracking-tight">
            {t("sections.sharex.title")}
          </h2>
          <p className="text-muted-foreground text-sm">{t("sections.sharex.desc")}</p>
        </div>
        <OneClickShareX
          appUrl={appUrl}
          appName={config.appName}
          username={username}
          showDomainNote={multiDomain}
        />
      </section>

      <div className="space-y-3">
        <div className="space-y-1">
          <h2 className="font-heading text-lg font-semibold tracking-tight">
            {t("advanced")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("advancedDesc")}
          </p>
        </div>

        <TokenManager
          tokens={tokens}
          appUrl={appUrl}
          appName={config.appName}
          userCode={session.user.userCode}
          userName={session.user.name ?? null}
          userEmail={session.user.email}
        />
      </div>

      <SetupGuide appUrl={appUrl} appName={config.appName} />
    </div>
  );
}
