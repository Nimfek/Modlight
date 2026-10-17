import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Images, Lock, FileDown } from "lucide-react";
import { config } from "@/lib/config";
import { getPublicFolder } from "@/lib/data/folders";
import { rawUrl, userBaseUrl } from "@/lib/media/urls";
import { isDisplayableImage } from "@/lib/media/mime";
import { ThemeApplier } from "@/components/theme-applier";
import { backgroundStyle } from "@/lib/background";
import { PublicGallery } from "@/components/public/PublicGallery";
import type { PublicTileItem } from "@/components/public/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageParams = { params: Promise<{ userCode: string; slug: string }> };

// ---------------------------------------------------------------------------
// Open Graph / Twitter metadata so the shared folder unfurls nicely.
// ---------------------------------------------------------------------------
export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { userCode, slug } = await params;
  const t = await getTranslations("public");
  const data = await getPublicFolder(userCode, slug);
  if (!data) return { title: t("album.notFoundTitle"), robots: { index: false, follow: false } };

  const { folder: album, owner, items } = data;
  const ownerCode = owner.userCode ?? userCode;
  // Canonical/OG links use the owner's chosen hostname (see lib/media/urls.ts).
  const ownerBase = userBaseUrl(owner.preferredDomain);
  const title = album.name;
  const ownerName = owner.name || t("album.anonymous");
  // No brand in the description: og:site_name below is the one place the card
  // names us, and saying it twice is what made these previews read as an advert.
  const description = t("album.metaDescription", {
    count: items.length,
    owner: ownerName,
  });
  const url = `${ownerBase}/a/${ownerCode}/${album.slug}`;

  const cover = items.find((i) => isDisplayableImage(i.mimeType, i.ext));
  const ogImage = cover
    ? `${rawUrl(ownerCode, cover.code, cover.ext, ownerBase)}?w=1200&h=630`
    : undefined;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
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
export default async function PublicFolderPage({ params }: PageParams) {
  const { userCode, slug } = await params;
  const t = await getTranslations("public");
  const data = await getPublicFolder(userCode, slug);
  if (!data) notFound();

  const { folder: album, owner, items } = data;
  const ownerCode = owner.userCode ?? userCode;
  const ownerName = owner.name || t("album.anonymous");
  const count = items.length;

  // Links and thumbnails are built on the owner's domain, not on whichever host
  // the visitor happens to be on, so a shared gallery matches the links its
  // owner hands out everywhere else.
  const ownerBase = userBaseUrl(owner.preferredDomain);

  // Only what a tile needs crosses into the client bundle.
  const tiles: PublicTileItem[] = items.map((item) => ({
    id: item.id,
    code: item.code,
    ext: item.ext,
    filename: item.filename,
    mimeType: item.mimeType,
    size: item.size,
    blurhash: item.blurhash,
  }));

  return (
    <main className="page-surface relative min-h-dvh w-full overflow-hidden">
      <ThemeApplier
        theme={owner.theme}
        background={backgroundStyle(owner.userCode, owner.backgroundKey, owner.backgroundDim)}
      />
      {/* Ambient violet glow + faint grid, matching the media viewer aesthetic. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            "radial-gradient(60rem 60rem at 50% -10%, color-mix(in oklch, var(--primary) 14%, transparent), transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--foreground) 1px, transparent 1px), linear-gradient(to bottom, var(--foreground) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(70% 50% at 50% 0%, #000, transparent)",
        }}
      />

      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
        {/* Header */}
        <header className="flex flex-col items-center gap-4 text-center">
          <div className="bg-primary/10 text-primary ring-primary/20 grid size-14 place-items-center rounded-2xl ring-1">
            <Images className="size-7" />
          </div>
          <div className="space-y-2">
            <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
              {album.name}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t("album.byOwner")} <span className="text-foreground font-medium">{ownerName}</span>
              <span aria-hidden className="mx-2 opacity-40">
                ·
              </span>
              {t("album.itemCount", { count })}
            </p>
          </div>

          {/* The ZIP link stays relative on purpose: the archive is streamed by
              whichever host the visitor is already on, so a large download never
              takes an extra cross-origin hop. */}
          {count > 0 ? (
            <a
              href={`/a/${ownerCode}/${album.slug}/zip`}
              className="bg-primary/10 text-primary ring-primary/20 hover:bg-primary/15 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ring-1 transition-colors"
            >
              <FileDown className="size-4" />
              {t("album.downloadAllZip")}
            </a>
          ) : null}
        </header>

        {/* Gallery */}
        {count === 0 ? (
          <div className="mt-14 flex flex-col items-center gap-3 text-center">
            <div className="bg-muted text-muted-foreground grid size-12 place-items-center rounded-2xl">
              <Lock className="size-6" />
            </div>
            <p className="text-muted-foreground text-sm">{t("album.empty")}</p>
          </div>
        ) : (
          <div className="mt-12">
            <PublicGallery
              items={tiles}
              userCode={ownerCode}
              base={ownerBase}
              label={t("gallery.folderLabel", { name: album.name })}
            />
          </div>
        )}
      </div>
    </main>
  );
}
