import { EMBED_CARD_VERSION, parseCardFile } from "@/lib/media/card";
import { renderCard } from "@/lib/media/card-render";

/**
 * `/embed/v1/archive-ZIP.png` - the picture a link preview shows for a file that
 * has no picture of its own.
 *
 * The URL names a CATEGORY and a TOKEN, never a file. That is deliberate and
 * load bearing:
 *  - nothing here can consume a view, because there is no row to consume one
 *    from. This handler imports neither lib/media/serve nor lib/db, and a test
 *    scans the source to keep it that way;
 *  - it is not an enumeration oracle. Every ZIP on the instance points at the
 *    same address, so a 200 here says nothing about whether any file exists;
 *  - Discord, Slack and friends get one cache entry per category instead of one
 *    per upload.
 *
 * Both segments are checked against closed lists before anything is drawn, so an
 * arbitrary string never reaches the renderer.
 */

export const runtime = "nodejs";

type Params = { params: Promise<{ version: string; card: string }> };

export async function GET(_req: Request, ctx: Params): Promise<Response> {
  const { version, card } = await ctx.params;
  if (version !== EMBED_CARD_VERSION) return notFound();

  const choice = parseCardFile(card);
  if (!choice) return notFound();

  const png = await renderCard(choice);

  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      // Safe to freeze forever precisely because redrawing the art means
      // bumping EMBED_CARD_VERSION, which mints new URLs. Discord copies an
      // og:image onto its own CDN and never revalidates, so there is nothing
      // to purge either way.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
