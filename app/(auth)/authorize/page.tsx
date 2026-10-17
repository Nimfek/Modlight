import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Unplug } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthorizePrompt } from "@/components/authorize/authorize-prompt";
import { authorizePath, parseAuthorizeRequest, type QueryValue } from "@/lib/authorize/loopback";
import { getSession } from "@/lib/auth-helpers";
import { config } from "@/lib/config";

/**
 * The permission prompt a desktop client sends people to.
 *
 * It lives in the (auth) route group rather than under (app) for a reason that
 * is not cosmetic: the app shell's `requireUser()` redirects to a bare `/login`,
 * which would drop `?port=&state=` on the floor, and the request cannot be
 * reconstructed afterwards — the app is already listening on a port nobody
 * remembers. Here the redirect is built by hand and carries the whole request
 * back through the sign-in (and 2FA) round trip.
 *
 * The page has NO side effect. Rendering it mints nothing; see
 * app/actions/authorize.ts.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("authorize");
  return {
    title: t("title"),
    // A permission prompt has no business in a search index, and the URL it is
    // reached by carries somebody's one-off nonce.
    robots: { index: false, follow: false },
  };
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ port?: QueryValue; state?: QueryValue; name?: QueryValue }>;
}) {
  const params = await searchParams;
  const t = await getTranslations("authorize");

  // Validated BEFORE the session check on purpose: a broken link should say so
  // rather than march an anonymous visitor through a sign-in to reach a dead
  // end. Nothing here is account-specific, so it reveals nothing either.
  const parsed = parseAuthorizeRequest(params);

  if (!parsed.ok) {
    return (
      <AuthCard title={t("invalid.title")} description={t("invalid.description")}>
        <div className="space-y-5 text-center">
          <div className="bg-muted text-muted-foreground mx-auto grid size-12 place-items-center rounded-2xl ring-1 ring-foreground/10">
            <Unplug className="size-6" />
          </div>
          <p className="text-muted-foreground text-sm leading-relaxed">{t("invalid.body")}</p>
          <Link
            href="/dashboard/tokens"
            className="text-foreground inline-block text-sm font-medium underline-offset-4 hover:underline"
          >
            {t("invalid.integrations")}
          </Link>
        </div>
      </AuthCard>
    );
  }

  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(authorizePath(parsed.request))}`);

  return (
    <AuthCard
      title={t("title")}
      description={t("description", { appName: config.appName })}
    >
      <AuthorizePrompt
        appName={config.appName}
        account={{ email: session.user.email }}
        request={{
          // The raw values the action re-validates. `port` crosses back as the
          // string it will be parsed from, so there is exactly one parser for
          // it and no chance of the page and the action disagreeing.
          port: String(parsed.request.port),
          state: parsed.request.state,
          clientName: parsed.request.clientName,
          callback: parsed.request.callback,
        }}
      />
    </AuthCard>
  );
}
