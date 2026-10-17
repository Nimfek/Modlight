import type { Metadata } from "next";
import { notFound } from "next/navigation";
import MediaPage, { generateMetadata as mediaMetadata } from "./[mediaCode]/page";
import { resolveTaglessOwnerTag } from "@/lib/data/user-prefs";
import { isReservedTag } from "@/lib/naming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageParams = { params: Promise<{ userCode: string }> };

/**
 * Tagless (root-level) media link: /{code}.{ext}.
 *
 * Produced for owners who turned on `user.skipTagInUrl` (admins only), so their
 * links read https://host/name.png instead of https://host/tag/name.png. The
 * tagged form keeps working for every file, including theirs — this is an extra
 * way in, never a replacement, so nothing already shared breaks.
 *
 * Collision safety, in order:
 *   1. Next.js matches static routes before dynamic ones, so /login,
 *      /dashboard, /register, /u/…, /a/…, /s/… and friends never reach this
 *      file — it only sees single segments nothing else claimed.
 *   2. RESERVED_TAGS (lib/naming.ts) is checked anyway, and deliberately also
 *      covers routes that do not exist yet (/help, /pricing, …) so a future
 *      page cannot be pre-empted by a file uploaded today.
 *   3. Resolution is restricted to owners who opted in. Without that, every
 *      upload in the system would silently gain a second, shorter URL and the
 *      per-user tag namespace would stop meaning anything.
 *
 * Rendering is delegated to the /{tag}/{code} page so view counting, the
 * password gate, expiry and the Open Graph tags have exactly one implementation.
 */

/** "/name.png" -> "name" (codes never contain dots). */
function codeOf(segment: string): string {
  return decodeURIComponent(segment).split(".")[0];
}

/** Owner's tag when this segment is a tagless media link, otherwise null. */
async function resolveTag(segment: string): Promise<string | null> {
  if (!segment || segment.startsWith(".")) return null;
  const code = codeOf(segment);
  if (!code || isReservedTag(segment) || isReservedTag(code)) return null;
  return resolveTaglessOwnerTag(code);
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { userCode: segment } = await params;
  const tag = await resolveTag(segment);
  if (!tag) return { title: "Not found", robots: { index: false, follow: false } };
  return mediaMetadata({ params: Promise.resolve({ userCode: tag, mediaCode: segment }) });
}

export default async function TaglessMediaPage({ params }: PageParams) {
  const { userCode: segment } = await params;
  const tag = await resolveTag(segment);
  if (!tag) notFound();
  return MediaPage({ params: Promise.resolve({ userCode: tag, mediaCode: segment }) });
}
