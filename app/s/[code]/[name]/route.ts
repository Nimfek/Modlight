import { redirectShortLink } from "@/lib/shortlinks";
import { scopedShortCode } from "@/lib/naming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Namespaced short link: /s/{userCode}/{code} -> target.
 *
 * The first segment is the owner's tag, which is stored as part of
 * short_links.code ("alicja/test"), so two users can both own "test".
 *
 * Naming note: the directory is [code]/[name], not [userCode]/[code] as first
 * sketched — Next.js refuses two different slug names for the same dynamic
 * position, and /s/[code] already exists for root-level links. So `code` here
 * is the tag and `name` is the leaf.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ code: string; name: string }> },
): Promise<Response> {
  const { code: tag, name } = await ctx.params;
  // Static routes win over dynamic ones in Next, so /s/x/unlock never reaches
  // this handler — belt and braces in case that ordering ever changes.
  if (name === "unlock") return new Response("Not found", { status: 404 });
  return redirectShortLink(scopedShortCode(tag, name));
}
