import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as users, userCodeAliases } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { AVATAR_CONTENT_TYPE, avatarToken, isAvatarKey } from "@/lib/avatar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve an account's avatar: GET /avatar/{tag}[?v=token]
 *
 * Public and unauthenticated, and it has to be: the picture appears in the admin
 * user list, beside a public gallery's owner, and anywhere else the account is
 * named. The bytes are always a WebP this app re-encoded itself (see
 * lib/media/avatar.ts), so nothing user-authored is ever served here.
 *
 * Keyed by tag rather than user id, and resolved through `user_code_aliases`
 * like every other public URL, so an avatar survives its owner renaming
 * themselves - the same guarantee the file links get.
 *
 * What the URL discloses, since other people see it: the tag (already the first
 * segment of every link this account hands out) and a random token. Not the
 * user id, not the address, not the name of the file it was made from, and
 * nothing that says whether that file was public.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ userCode: string }> },
): Promise<Response> {
  const { userCode } = await ctx.params;

  const key = await lookupKey(userCode);
  // Anything that is not one of our own storage keys is not ours to stream.
  // `user.image` is Better Auth's column, so a future provider writing an http
  // URL into it must 404 here rather than being read as a path.
  if (!isAvatarKey(key)) return new Response(null, { status: 404 });

  // The `v` in the URL is the key's own token. A request carrying the wrong one
  // is pointing at an avatar that has since been replaced, so it must not be
  // answered from cache as though it were current.
  const asked = new URL(req.url).searchParams.get("v");
  const token = avatarToken(key);
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
      "Content-Type": AVATAR_CONTENT_TYPE,
      "Content-Length": String(stat.size),
      // Immutable is safe precisely because replacing an avatar mints a new
      // token: the old URL is never requested again, so nothing needs purging.
      // Without a matching token the answer is still correct, just short-lived.
      "Cache-Control": immutable
        ? "public, max-age=31536000, immutable"
        : "public, max-age=60, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}

/**
 * Current tag first, then retired ones. Returns null when there is no avatar.
 *
 * A 404 here is not a failure state: the components fall back to initials the
 * moment the image does not load, which is exactly what should happen for an
 * account that has never set one.
 */
async function lookupKey(userCode: string): Promise<string | null> {
  const direct = await db
    .select({ key: users.image })
    .from(users)
    .where(eq(users.userCode, userCode))
    .limit(1);
  if (direct[0]) return direct[0].key ?? null;

  const viaAlias = await db
    .select({ key: users.image })
    .from(userCodeAliases)
    .innerJoin(users, eq(users.id, userCodeAliases.userId))
    .where(eq(userCodeAliases.code, userCode))
    .limit(1);

  return viaAlias[0]?.key ?? null;
}
