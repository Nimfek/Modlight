import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { shortLinks, user as users } from "@/lib/db/schema";
import { config } from "@/lib/config";
import { BrandMark } from "@/components/auth/brand-mark";
import { AuthCard } from "@/components/auth/auth-card";
import { ThemeApplier } from "@/components/theme-applier";
import { backgroundStyle } from "@/lib/background";
import { UnlockForm } from "./unlock-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("public");
  return {
    title: t("shortlink.metaTitle"),
    robots: { index: false, follow: false },
  };
}

/**
 * Public gate page for a password-protected short link. Renders a small branded
 * card with a password form; on success the form drops the unlock cookie and
 * navigates back to /s/{code}, which then passes the gate and redirects.
 *
 * Like every other public surface (file preview, album, user gallery) this page
 * wears the OWNER's skin rather than the visitor's: a shared link is the
 * owner's page, whoever opens it. The skin is joined in here so the gate is not
 * the one screen in the chain that flips back to the visitor's own theme.
 */
export default async function ShortlinkUnlockPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const t = await getTranslations("public");

  // LEFT join: the owner row is guaranteed by an FK, but a missing one must
  // degrade to the default skin, never to a 404 on a link that still works.
  const rows = await db
    .select({
      id: shortLinks.id,
      passwordHash: shortLinks.passwordHash,
      ownerTheme: users.theme,
      ownerUserCode: users.userCode,
      ownerBackgroundKey: users.backgroundKey,
      ownerBackgroundDim: users.backgroundDim,
    })
    .from(shortLinks)
    .leftJoin(users, eq(users.id, shortLinks.ownerId))
    .where(eq(shortLinks.code, code))
    .limit(1);

  const link = rows[0];
  if (!link) notFound();
  // No password set — nothing to gate; bounce straight to the redirect route.
  if (!link.passwordHash) redirect(`/s/${code}`);

  return (
    <div className="page-surface relative flex min-h-svh flex-col overflow-hidden">
      {/* First child on purpose: ThemeApplier emits a blocking inline script, so
          it has to run before the browser paints the wrong theme. */}
      <ThemeApplier
        theme={link.ownerTheme}
        background={backgroundStyle(
          link.ownerUserCode,
          link.ownerBackgroundKey,
          link.ownerBackgroundDim,
        )}
      />
      {/* Ambient background mirrors the auth shell, using token-driven accents. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="bg-primary/10 absolute -bottom-40 left-1/2 size-[44rem] -translate-x-1/2 rounded-full blur-2xl" />
      </div>

      <header className="relative z-10 flex items-center justify-center px-6 pt-10 sm:justify-start sm:px-10">
        <BrandMark appName={config.appName} href="/" />
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-10 sm:py-12">
        <div className="w-full max-w-sm">
          <AuthCard
            title={t("shortlink.cardTitle")}
            description={t("shortlink.cardDescription")}
          >
            <UnlockForm code={code} />
          </AuthCard>
        </div>
      </main>

      <footer className="text-muted-foreground relative z-10 flex items-center justify-center px-6 pb-8 text-center text-xs">
        <p>
          &copy; {new Date().getFullYear()} {config.appName}
        </p>
      </footer>
    </div>
  );
}
