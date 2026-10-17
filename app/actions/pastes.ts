"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads, user as users } from "@/lib/db/schema";
import { requireUser } from "@/lib/auth-helpers";
import { getStorage } from "@/lib/storage";
import { humanCode, secureToken } from "@/lib/ids";
import { storageKeyFor, publicUrl, rawUrl, userBaseUrl } from "@/lib/media/urls";
import { contentHash } from "@/lib/media/derived-cache";
import { defaultPasswordStamp, getUserPrefs } from "@/lib/data/user-prefs";
import { hashPassword } from "@/lib/password";
import { LANG_EXT } from "@/lib/paste-languages";
import { pasteMimeType } from "@/lib/media/paste-type";

async function uniqueCode(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const c = humanCode(10);
    const hit = await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.code, c)).limit(1);
    if (!hit.length) return c;
  }
  throw new Error("Could not allocate a unique code");
}

export interface CreatePasteInput {
  content: string;
  language?: string;
  title?: string;
  /** Lifetime in days. Ignored when `expiresInMinutes` is given. */
  expiresInDays?: number | null;
  /** Lifetime in minutes — the finer-grained form, wins over `expiresInDays`. */
  expiresInMinutes?: number | null;
  password?: string | null;
  /**
   * Burn after N opens. 1 = a one-time link.
   *
   * The column and its enforcement already exist (lib/media/serve.ts →
   * `consumeView` decrements atomically and 404s once the budget is spent); a
   * paste simply gets to set it at creation time instead of having to be edited
   * afterwards in the dashboard.
   */
  maxViews?: number | null;
}

/**
 * View budgets are stored in an int4 column, so anything past 2^31 would
 * overflow. A million opens is far beyond what "burn after N views" is for, and
 * capping here means a hand-crafted call cannot write a value the database has
 * to reject.
 */
const MAX_VIEW_BUDGET = 1_000_000;

/** Normalise a requested view cap, or null when there is no cap. */
function normaliseMaxViews(input: number | null | undefined): number | null {
  if (input == null) return null;
  const n = Number(input);
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  if (floored < 1) return null;
  return Math.min(floored, MAX_VIEW_BUDGET);
}

export interface PasteResult {
  code: string;
  url: string;
  rawUrl: string;
  /** What was actually stored, so the success screen states facts, not intent. */
  expiresAt: string | null;
  maxViews: number | null;
  hasPassword: boolean;
}

/** Create a text/code paste — stored as a text "upload" so it reuses links, expiry, password, viewing. */
export async function createPaste(input: CreatePasteInput): Promise<PasteResult> {
  const session = await requireUser();
  const content = input.content ?? "";
  if (!content.trim()) throw new Error("Paste is empty");
  if (content.length > 5_000_000) throw new Error("Paste is too large (max ~5MB)");

  const lang = (input.language || "text").toLowerCase();
  const ext = LANG_EXT[lang] ?? "txt";
  const buf = Buffer.from(content, "utf8");

  const maxQuota = session.user.maxQuota;
  const used = session.user.usedQuota ?? 0;
  if (maxQuota != null && maxQuota !== -1 && used + buf.length > maxQuota) {
    throw new Error("Quota exceeded");
  }

  const code = await uniqueCode();
  const userCode = session.user.userCode ?? "u";
  const key = storageKeyFor(userCode, code, ext);
  await getStorage().write(key, buf);

  const filename = `${(input.title?.trim() || "paste").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "paste"}.${ext}`;

  const minutes =
    input.expiresInMinutes != null && Number.isFinite(input.expiresInMinutes) && input.expiresInMinutes > 0
      ? Math.floor(input.expiresInMinutes)
      : input.expiresInDays
        ? Math.floor(input.expiresInDays) * 1440
        : null;
  const expiresAt = minutes ? new Date(Date.now() + minutes * 60_000) : null;

  // A password typed here is a decision about THIS paste, so it wins and stores
  // no generation (password_version stays null) - which is what stops an
  // account-wide "remember for 30 days" consent from opening it.
  //
  // With no password typed, the account default applies. A paste is something
  // you share by link exactly like a file, so "password-protect what I share"
  // that skipped pastes would be a hole in the setting rather than a nicety.
  const chosen = input.password ? await hashPassword(input.password) : null;
  const stamp = chosen ? null : await defaultPasswordStamp(session.user.id);
  const passwordHash = chosen ?? stamp?.passwordHash ?? null;
  const passwordVersion = chosen ? null : (stamp?.passwordVersion ?? null);
  const maxViews = normaliseMaxViews(input.maxViews);

  await db.insert(uploads).values({
    ownerId: session.user.id,
    code,
    filename,
    ext,
    kind: "paste",
    language: lang,
    // The language the author picked, not a placeholder. This used to be
    // hardcoded to text/plain for every paste, which is why a paste created as
    // HTML had no source/page toggle while an uploaded page.html did: nothing
    // downstream ever read `language`, so the two rows were indistinguishable.
    //
    // `pasteMimeType` refuses any type that /raw would not serve as text, so
    // this cannot widen what leaves the server (lib/media/paste-type.ts).
    mimeType: pasteMimeType(lang) ?? "text/plain; charset=utf-8",
    size: buf.length,
    // Free here, and worth having: the bytes are already in memory, so this
    // costs a hash of at most 5 MB rather than the extra full read that pricing
    // a checksum onto a resumable upload would mean. Without it every paste
    // looked "unchecksummed" to duplicate detection and to the ETag path.
    checksum: contentHash(buf),
    storageKey: key,
    published: session.user.hideUploads ? false : true,
    deleteToken: secureToken(16),
    expiresAt,
    passwordHash,
    passwordVersion,
    maxViews,
  });
  await db.update(users).set({ usedQuota: sql`${users.usedQuota} + ${buf.length}` }).where(eq(users.id, session.user.id));

  revalidatePath("/dashboard");
  // Same hostname the user's uploads are handed out on, so a paste link doesn't
  // look like it came from a different service.
  const base = userBaseUrl((await getUserPrefs(session.user.id))?.preferredDomain ?? null);
  return {
    code,
    url: publicUrl(userCode, code, ext, base),
    rawUrl: rawUrl(userCode, code, ext, base),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    maxViews,
    hasPassword: !!passwordHash,
  };
}
