import { redirectShortLink } from "@/lib/shortlinks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Root-level short link: /s/{code} -> target.
 *
 * Kept for links created before per-user namespacing and for the (privileged)
 * root namespace. Namespaced links live one segment deeper — see
 * app/s/[code]/[name]/route.ts.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }): Promise<Response> {
  const { code } = await ctx.params;
  return redirectShortLink(code);
}
