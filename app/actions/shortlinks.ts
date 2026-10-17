"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { shortLinks } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth-helpers";
import { createShortLinkFor, normalizeTarget } from "@/lib/shortlinks";
import type { CreateShortLinkInput, CreateShortLinkResult } from "@/lib/shortlinks";

/**
 * The panel's entry points into short links.
 *
 * The rules themselves live in `lib/shortlinks` because `POST /api/shortlinks`
 * enforces the same ones for the desktop client. What stays here is what is
 * genuinely the panel's: the session, and revalidating the page that lists them.
 */

export type {
  ShortLinkIssue,
  CreateShortLinkInput,
  CreateShortLinkResult,
} from "@/lib/shortlinks";

export async function createShortLink(input: CreateShortLinkInput): Promise<CreateShortLinkResult> {
  const session = await requireUser();
  const result = await createShortLinkFor(session.user.id, input);
  if (result.ok) revalidatePath("/dashboard/links");
  return result;
}

export type RetargetShortLinkResult =
  | { ok: true; target: string }
  | { ok: false; reason: "invalid-url" | "not-found" };

/**
 * Point an existing short link somewhere else, keeping its code.
 *
 * This is what turns a short link into a STABLE ADDRESS rather than a one-shot
 * alias, and it exists for release channels: the downloader companion checks
 * `/s/{tag}/ytdl-manifest` on every start, so that URL has to outlive the file
 * it currently names. Without this, shipping a new build would mean a new link
 * and every already-installed copy pointing at the previous release forever.
 *
 * The target goes through the same `normalizeTarget` as creation, so a
 * `javascript:` or `data:` URL cannot be smuggled in through the back door of
 * an edit — a shortener that redirects to a script URL is an XSS vector on
 * whatever domain serves it, and the check being on the create path only would
 * have made this the way around it.
 *
 * Ownership is folded into the WHERE clause rather than checked first: a
 * separate SELECT would leave a window in which the row changes hands, and the
 * single statement makes "not mine" and "does not exist" the same answer.
 */
export async function retargetShortLink(
  id: string,
  target: string,
): Promise<RetargetShortLinkResult> {
  const session = await requireUser();
  const normalized = normalizeTarget(target);
  if (!normalized) return { ok: false, reason: "invalid-url" };

  const rows = await db
    .update(shortLinks)
    .set({ target: normalized })
    .where(and(eq(shortLinks.id, id), eq(shortLinks.ownerId, session.user.id)))
    .returning({ target: shortLinks.target });

  if (!rows[0]) return { ok: false, reason: "not-found" };

  revalidatePath("/dashboard/links");
  return { ok: true, target: rows[0].target };
}

export async function deleteShortLink(id: string): Promise<void> {
  const session = await requireUser();
  await db.delete(shortLinks).where(and(eq(shortLinks.id, id), eq(shortLinks.ownerId, session.user.id)));
  revalidatePath("/dashboard/links");
}

export async function listShortLinks() {
  const session = await requireUser();
  return db.select().from(shortLinks).where(eq(shortLinks.ownerId, session.user.id)).orderBy(desc(shortLinks.createdAt));
}
