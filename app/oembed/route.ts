import { config } from "@/lib/config";
import { getMedia } from "@/lib/media/serve";
import { rawUrl, userBaseUrl } from "@/lib/media/urls";
import { mediaKind } from "@/lib/media/mime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * oEmbed provider endpoint (https://oembed.com). Rich clients (Discord, etc.)
 * discover this via the <link rel="alternate" type="application/json+oembed">
 * we emit from the media page's metadata, then fetch it to render an embed.
 *
 * GET /oembed?url={publicUrl}&format=json
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = url.searchParams.get("url");
  const format = url.searchParams.get("format") ?? "json";

  if (format !== "json") {
    return Response.json({ error: "Only json format is supported" }, { status: 501 });
  }
  if (!target) {
    return Response.json({ error: "Missing url parameter" }, { status: 400 });
  }

  // Parse {userCode}/{code}.{ext} out of the supplied public URL.
  let userCode: string | undefined;
  let mediaCode: string | undefined;
  try {
    const parsed = new URL(target);
    const segments = parsed.pathname.split("/").filter(Boolean);
    // Tolerate trailing /raw, /download etc. — we only need the first two.
    [userCode, mediaCode] = segments;
  } catch {
    return Response.json({ error: "Invalid url parameter" }, { status: 400 });
  }
  if (!userCode || !mediaCode) {
    return Response.json({ error: "Invalid url parameter" }, { status: 400 });
  }

  const found = await getMedia(userCode, mediaCode);
  if (!found) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const { media, ownerUserCode, ownerPreferredDomain } = found;

  // Don't leak embeds for private or password-protected media.
  if (!media.published || media.passwordHash) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Same hostname the owner's other links use, so the embed and the link the
  // viewer clicked agree with each other.
  const ownerBase = userBaseUrl(ownerPreferredDomain);
  const raw = rawUrl(ownerUserCode, media.code, media.ext, ownerBase);
  const kind = mediaKind(media.mimeType, media.ext);

  // `author_name` is deliberately absent. Discord renders it as a bold line of
  // its own above the title, so filling it with the product name was the fourth
  // place one card said the same word. The provider name is the brand, exactly
  // as og:site_name says it: Slack prefers oEmbed over the meta tags, so the two
  // must agree or the same link gets signed two different ways.
  const base = {
    version: "1.0",
    title: media.filename,
    provider_name: config.embedBrand,
    provider_url: ownerBase,
    cache_age: 86400,
  };

  if (kind === "image") {
    return oembedJson({
      ...base,
      type: "photo",
      url: raw,
      width: media.width ?? 1200,
      height: media.height ?? 630,
    });
  }

  if (kind === "video") {
    const w = media.width ?? 1280;
    const h = media.height ?? 720;
    return oembedJson({
      ...base,
      type: "video",
      width: w,
      height: h,
      // No thumbnail_url: it used to point at `raw?w=1200&h=630`, but the
      // thumbnail endpoint only rasterizes images, so for a video that URL
      // streams the entire clip back as the "still".
      html: `<video src="${escapeAttr(raw)}" controls width="${w}" height="${h}" style="max-width:100%;border-radius:12px"></video>`,
    });
  }

  // Everything else degrades to a link card.
  return oembedJson({
    ...base,
    type: "link",
    url: raw,
  });
}

function oembedJson(body: Record<string, unknown>): Response {
  return Response.json(body, {
    headers: {
      "Cache-Control": "public, max-age=86400, s-maxage=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
