import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as users, userCodeAliases } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { BACKGROUND_CONTENT_TYPE, backgroundToken } from "@/lib/background";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve an account's wallpaper: GET /bg/{tag}[?v=token]
 *
 * Public and unauthenticated, because it is painted behind public pages too -
 * a visitor looking at somebody's shared file sees that account's decoration.
 * The bytes are always a WebP this app re-encoded itself (see
 * app/api/background/route.ts), so nothing user-authored is ever served here.
 *
 * Keyed by tag rather than user id, and resolved through `user_code_aliases`
 * like every other public URL, so a wallpaper survives its owner renaming
 * themselves - the same guarantee the file links get.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ userCode: string }> },
): Promise<Response> {
  const { userCode } = await ctx.params;

  const key = await lookupKey(userCode);
  if (!key) return new Response(null, { status: 404 });

  // The `v` in the URL is the key's own token. A request carrying the wrong one
  // is pointing at a wallpaper that has since been replaced, so it must not be
  // answered from cache as though it were current.
  const asked = new URL(req.url).searchParams.get("v");
  const token = backgroundToken(key);
  const immutable = !!asked && asked === token;

  const storage = getStorage();
  const stat = await storage.stat(key);
  if (!stat) return new Response(null, { status: 404 });

  let stream: Awaited<ReturnType<typeof storage.readStream>>;
  try {
    stream = await storage.readStream(key);
  } catch {
    return new Response(null, { status: 404 });
  }

  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": BACKGROUND_CONTENT_TYPE,
      "Content-Length": String(stat.size),
      // Immutable is safe precisely because replacing a wallpaper mints a new
      // token: the old URL is never requested again, so nothing needs purging.
      "Cache-Control": immutable
        ? "public, max-age=31536000, immutable"
        : "public, max-age=60, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      // Decoration, not a document. Nothing here should ever be framed, sniffed
      // or treated as a page.
      "Content-Disposition": "inline",
    },
  });
}

/** Current tag first, then retired ones. Returns null when there is no wallpaper. */
async function lookupKey(userCode: string): Promise<string | null> {
  const direct = await db
    .select({ key: users.backgroundKey })
    .from(users)
    .where(eq(users.userCode, userCode))
    .limit(1);
  if (direct[0]) return direct[0].key ?? null;

  const viaAlias = await db
    .select({ key: users.backgroundKey })
    .from(userCodeAliases)
    .innerJoin(users, eq(users.id, userCodeAliases.userId))
    .where(eq(userCodeAliases.code, userCode))
    .limit(1);

  return viaAlias[0]?.key ?? null;
}
