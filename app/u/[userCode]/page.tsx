import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Images } from "lucide-react";
import { db } from "@/lib/db";
import { user as users, uploads } from "@/lib/db/schema";
import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { rawUrl, userBaseUrl } from "@/lib/media/urls";
import { isDisplayableImage } from "@/lib/media/mime";
import { config } from "@/lib/config";
import { ThemeApplier } from "@/components/theme-applier";
import { backgroundStyle } from "@/lib/background";
import { avatarUrl } from "@/lib/avatar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PublicGallery } from "@/components/public/PublicGallery";
import type { PublicTileItem } from "@/components/public/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageParams = { params: Promise<{ userCode: string }> };

const ITEM_LIMIT = 200;

type GalleryUser = {
  id: string;
  name: string;
  userCode: string;
  theme: string | null;
  /** Hostname this user's links are generated with (null = default). */
  preferredDomain: string | null;
  /** Wallpaper, so the gallery is decorated the way its owner decorated the panel. */
  backgroundKey: string | null;
  backgroundDim: number | null;
  /** Storage key of the owner's avatar, resolved to a URL at render time. */
  image: string | null;
};

/**
 * Load the public profile: the user (by userCode) and their PUBLIC, non-deleted
 * file uploads (pastes excluded), newest first. Returns null when the userCode
 * doesn't resolve to a user.
 */
async function loadGallery(
  userCode: string,
): Promise<{ owner: GalleryUser; items: PublicTileItem[] } | null> {
  const ownerRows = await db
    .select({
      id: users.id,
      name: users.name,
      userCode: users.userCode,
      theme: users.theme,
      preferredDomain: users.preferredDomain,
      publicProfile: users.publicProfile,
      backgroundKey: users.backgroundKey,
      backgroundDim: users.backgroundDim,
      image: users.image,
    })
    .from(users)
    .where(eq(users.userCode, userCode))
    .limit(1);

  const owner = ownerRows[0];
  if (!owner || !owner.userCode) return null;

  /**
   * Opt-in, and it has to be checked HERE.
   *
   * The column defaulted to false and the toggle wrote to it, but nothing ever
   * read it — so every account had a browsable index of its library at a short,
   * guessable address (`/u/alicja`, `/u/root`). Publishing someone's whole
   * library is a decision they make, not one the absence of a check makes for
   * them.
   */
  if (!owner.publicProfile) return null;

  const items = await db
    .select({
      id: uploads.id,
      code: uploads.code,
      ext: uploads.ext,
      filename: uploads.filename,
      mimeType: uploads.mimeType,
      size: uploads.size,
      blurhash: uploads.blurhash,
    })
    .from(uploads)
    .where(
      and(
        eq(uploads.ownerId, owner.id),
        eq(uploads.published, true),
        isNull(uploads.deletedAt),
        eq(uploads.kind, "file"),
        // The same gates the public folder gallery applies. A filename is
        // information too: listing `raport-finansowy.xlsx` as password-protected
        // defeats half the point of the password, and an expired or burnt-out
        // link should stop existing everywhere, not just where it is served.
        isNull(uploads.passwordHash),
        sql`(${uploads.expiresAt} is null or ${uploads.expiresAt} > now())`,
        sql`(${uploads.maxViews} is null or ${uploads.views} < ${uploads.maxViews})`,
      ),
    )
    .orderBy(desc(uploads.createdAt))
    .limit(ITEM_LIMIT);

  return { owner: { ...owner, userCode: owner.userCode }, items };
}

// ---------------------------------------------------------------------------
// Metadata — Open Graph profile card (first public image becomes og:image).
// ---------------------------------------------------------------------------
export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { userCode } = await params;
  const t = await getTranslations("public");
  const data = await loadGallery(userCode);
  if (!data) {
    return { title: t("profile.notFoundTitle"), robots: { index: false, follow: false } };
  }

  const { owner, items } = data;
  // Neither the title nor the description carries the brand: og:site_name below
  // is the single place the card names us.
  const title = t("profile.metaTitle", { name: owner.name });
  const description = t("profile.metaDescription", { tag: owner.userCode });
  // Canonical/OG links use the owner's chosen hostname (see lib/media/urls.ts).
  const ownerBase = userBaseUrl(owner.preferredDomain);
  const url = `${ownerBase}/u/${owner.userCode}`;

  const firstImage = items.find((i) => isDisplayableImage(i.mimeType, i.ext));
  const ogImage = firstImage
    ? `${rawUrl(owner.userCode, firstImage.code, firstImage.ext, ownerBase)}?w=1200&h=630`
    : undefined;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "profile",
      title,
      description,
      siteName: config.embedBrand,
      url,
      images: ogImage ? [{ url: ogImage, width: 1200, height: 630, alt: title }] : undefined,
    },
    twitter: {
      card: ogImage ? "summary_large_image" : "summary",
      title,
      description,
      images: ogImage ? [ogImage] : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default async function UserGalleryPage({ params }: PageParams) {
  const { userCode } = await params;
  const t = await getTranslations("public");
  const data = await loadGallery(userCode);
  if (!data) notFound();

  const { owner, items } = data;
  const count = items.length;
  // Every link and thumbnail is built on the owner's domain (lib/media/urls.ts).
  const ownerBase = userBaseUrl(owner.preferredDomain);
  // Root-relative, so it stays same-origin whichever hostname this was opened on.
  const ownerAvatar = avatarUrl(owner.userCode, owner.image);

  return (
    <main className="page-surface text-foreground min-h-dvh w-full">
      <ThemeApplier
        theme={owner.theme}
        background={backgroundStyle(owner.userCode, owner.backgroundKey, owner.backgroundDim)}
      />

      {/* Ambient glow header backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80"
        style={{
          backgroundImage:
            "radial-gradient(50rem 28rem at 50% -20%, color-mix(in oklch, var(--primary) 16%, transparent), transparent 70%)",
        }}
      />

      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-16">
        {/* Header */}
        <header className="border-border flex flex-col gap-3 border-b pb-8">
          <div className="flex items-center gap-2">
            {/* This block IS the owner's identity, so their avatar belongs here
                - and the settings card promises exactly that ("anyone who can
                see your links or your galleries can see it"). Accounts without
                one keep the gallery tile they have always had. */}
            {ownerAvatar ? (
              <Avatar className="ring-primary/20 size-12 ring-1">
                <AvatarImage src={ownerAvatar} alt="" />
                <AvatarFallback className="bg-primary/10 text-primary">
                  <Images className="size-6" />
                </AvatarFallback>
              </Avatar>
            ) : (
              <span className="bg-primary/10 text-primary ring-primary/20 grid size-12 place-items-center rounded-2xl ring-1">
                <Images className="size-6" />
              </span>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">
                {owner.name}
              </h1>
              <p className="text-muted-foreground truncate text-sm">@{owner.userCode}</p>
            </div>
          </div>
          <p className="text-muted-foreground text-sm">
            {t("profile.uploadCount", { count })}
            {count >= ITEM_LIMIT ? ` ${t("profile.showingLatest")}` : ""}
          </p>
        </header>

        {/* Gallery */}
        {count === 0 ? (
          <EmptyState
            title={t("profile.emptyTitle")}
            body={t("profile.emptyBody", { name: owner.name })}
          />
        ) : (
          <div className="mt-8">
            <PublicGallery
              items={items}
              userCode={owner.userCode}
              base={ownerBase}
              label={t("gallery.profileLabel", { name: owner.name })}
            />
          </div>
        )}
      </div>
    </main>
  );
}

/** Empty state when the user has no public files. */
function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="border-border bg-card/40 mt-8 flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-20 text-center">
      <span className="bg-muted text-muted-foreground grid size-14 place-items-center rounded-2xl">
        <Images className="size-7" />
      </span>
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="text-muted-foreground max-w-sm text-sm">{body}</p>
    </div>
  );
}
