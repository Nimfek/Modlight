"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { folders, uploads, user as users, userCodeAliases } from "@/lib/db/schema";
import { auth } from "@/lib/auth";
import { requireUser, requireAdmin } from "@/lib/auth-helpers";
import { countFilesOnDefaultPassword, getDefaultPasswordPrefs } from "@/lib/data/user-prefs";
import { listMySessions, mySessionToken } from "@/lib/data/sessions";
import { hashPassword } from "@/lib/password";
import { pendingInviteUserIds } from "@/lib/invites";
import { isThemeId, resolveTheme } from "@/lib/themes";
import { SKIN_COOKIE, THEME_COOKIE_MAX_AGE } from "@/lib/theme-cookies";
import {
  checkTag,
  isNamingScheme,
  buildCodeBase,
  clampRandomLength,
  clampWordCount,
  type NamingScheme,
} from "@/lib/naming";
import { isKnownDomain, userBaseUrl } from "@/lib/media/urls";
import { backgroundUrl, clampDim, DIM_DEFAULT } from "@/lib/background";
import { avatarUrl } from "@/lib/avatar";
import { UNLIMITED_QUOTA } from "@/lib/quota";
import type { AdminUserRow } from "@/lib/admin-users";

export interface PreferencesResult {
  /** The skin the database holds AFTER the write — never the requested one. */
  theme: string;
  locale: string | null;
}

/**
 * Persist the account preferences edited on /dashboard/profile.
 *
 * Returns what the row actually contains afterwards. The skin in particular has
 * to be read back rather than assumed: the caller repaints the entire document
 * from it, and an UPDATE that matched no row is indistinguishable from a
 * successful save until the next reload puts the old skin back — which is
 * exactly how "the theme picker does nothing" presented.
 */
export async function updatePreferences(input: {
  name?: string;
  hideUploads?: boolean;
  copyRaw?: boolean;
  theme?: string;
  locale?: string | null;
}): Promise<PreferencesResult> {
  const session = await requireUser();
  const patch: Record<string, unknown> = {};
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, 120);
  if (typeof input.hideUploads === "boolean") patch.hideUploads = input.hideUploads;
  if (typeof input.copyRaw === "boolean") patch.copyRaw = input.copyRaw;
  if (typeof input.theme === "string" && isThemeId(input.theme)) patch.theme = input.theme;
  if ("locale" in input) patch.locale = input.locale === "pl" || input.locale === "en" ? input.locale : null;

  if (Object.keys(patch).length === 0) {
    return { theme: resolveTheme(session.user.theme), locale: session.user.locale ?? null };
  }

  const [row] = await db
    .update(users)
    .set(patch)
    .where(eq(users.id, session.user.id))
    .returning({ theme: users.theme, locale: users.locale });

  if (!row) throw new Error("Preferences could not be saved");

  const theme = resolveTheme(row.theme);
  const jar = await cookies();

  // The root layout paints <html data-theme> from `ml_skin`, so that cookie is
  // what decides the FIRST frame of every later request. Writing it here — on
  // the server, in the same action as the database write — is what makes a skin
  // change survive a reload. Leaving it to the client-side applier meant the
  // next server render still emitted the previous skin and the choice appeared
  // to roll back on its own.
  if (patch.theme) {
    jar.set(SKIN_COOKIE, theme, { path: "/", maxAge: THEME_COOKIE_MAX_AGE, sameSite: "lax" });
  }

  // Reflect the language choice into the `ml_locale` cookie so the next render
  // (and SSR locale detection) uses it immediately. null = auto -> clear cookie.
  if ("locale" in input) {
    if (patch.locale === "pl" || patch.locale === "en") {
      jar.set("ml_locale", patch.locale as string, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
    } else {
      jar.delete("ml_locale");
    }
  }

  // <html> belongs to the ROOT layout: revalidating only the profile page would
  // leave the document element rendering the skin it had before.
  revalidatePath("/", "layout");

  return { theme, locale: row.locale ?? null };
}

/**
 * Why a tag cannot be used. The client maps these to translated copy — Next
 * masks the *message* of an error thrown from a Server Action in production, so
 * anything the user must actually read has to travel as data, not as an
 * exception.
 */
export type TagIssue =
  | "too-short"
  | "too-long"
  | "charset"
  | "reserved"
  | "taken"
  | "retired"
  | "error";

export type TagCheckResult =
  | { status: "ok" }
  | { status: "current" }
  | { status: "unavailable"; reason: TagIssue };

/**
 * Live availability check for the tag field. Read-only and cheap: two indexed
 * lookups. Runs on every debounced keystroke, so it never mutates anything.
 */
export async function checkTagAvailability(tag: string): Promise<TagCheckResult> {
  const session = await requireUser();
  const clean = tag.trim();

  const check = checkTag(clean);
  if (!check.ok) return { status: "unavailable", reason: check.reason! };

  const current = session.user.userCode ?? null;
  if (current && clean === current) return { status: "current" };

  const conflict = await tagConflict(clean, session.user.id);
  return conflict ? { status: "unavailable", reason: conflict } : { status: "ok" };
}

/**
 * Is `tag` claimed by somebody other than `userId` — either as their current
 * tag, or as one they retired (aliases keep resolving forever, so handing one
 * over would redirect their old links into this account's namespace).
 */
async function tagConflict(tag: string, userId: string): Promise<"taken" | "retired" | null> {
  const owner = await db.select({ id: users.id }).from(users).where(eq(users.userCode, tag)).limit(1);
  if (owner[0] && owner[0].id !== userId) return "taken";

  const alias = await db
    .select({ userId: userCodeAliases.userId })
    .from(userCodeAliases)
    .where(eq(userCodeAliases.code, tag))
    .limit(1);
  if (alias[0] && alias[0].userId !== userId) return "retired";

  return null;
}

/**
 * Change the user's tag — the first segment of every public URL.
 *
 * The previous tag is parked in `user_code_aliases` and keeps resolving, so
 * links already shared (there are thousands in circulation) never break. A tag
 * can therefore never be reused by anyone else, even after being abandoned.
 */
export async function updateTag(
  tag: string,
): Promise<{ ok: true; tag: string } | { ok: false; reason: TagIssue }> {
  const session = await requireUser();
  const clean = tag.trim();

  const check = checkTag(clean);
  if (!check.ok) return { ok: false, reason: check.reason! };

  const current = session.user.userCode ?? null;
  if (current && clean === current) return { ok: true, tag: clean };

  try {
    await db.transaction(async (tx) => {
      // Taken by another account, or retired by one? Both are hard stops.
      const owner = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.userCode, clean))
        .limit(1);
      if (owner[0] && owner[0].id !== session.user.id) throw new TagConflict("taken");

      const alias = await tx
        .select({ userId: userCodeAliases.userId })
        .from(userCodeAliases)
        .where(eq(userCodeAliases.code, clean))
        .limit(1);
      if (alias[0] && alias[0].userId !== session.user.id) throw new TagConflict("retired");

      if (current) {
        await tx
          .insert(userCodeAliases)
          .values({ code: current, userId: session.user.id })
          .onConflictDoNothing();
      }

      await tx.update(users).set({ userCode: clean }).where(eq(users.id, session.user.id));
    });
  } catch (err) {
    if (err instanceof TagConflict) return { ok: false, reason: err.reason };
    // Unique-index race: someone claimed the tag between the check and the write.
    return { ok: false, reason: "error" };
  }

  revalidatePath("/dashboard/profile");
  revalidatePath("/dashboard");
  return { ok: true, tag: clean };
}

/** Rolls the transaction back while carrying a reason the UI can translate. */
class TagConflict extends Error {
  constructor(readonly reason: "taken" | "retired") {
    super(reason);
  }
}

/**
 * Admin-only: generate links for NEW uploads without the tag segment
 * (https://host/name.png instead of https://host/tag/name.png).
 *
 * The role is checked HERE, on the server, not just hidden in the UI — a
 * tagless code occupies the root namespace shared with every top-level route,
 * so it is not something an arbitrary account may claim. Files already uploaded
 * keep the tagged URL they were shared with; both forms resolve.
 */
export async function updateSkipTagInUrl(enabled: boolean): Promise<void> {
  const session = await requireAdmin();
  await db.update(users).set({ skipTagInUrl: enabled }).where(eq(users.id, session.user.id));
  revalidatePath("/dashboard/profile");
  revalidatePath("/dashboard");
}

/**
 * Admin-only: let a specific user create short links at the root of the
 * shortener domain (no /{userCode}/ prefix).
 */
export async function setAllowRootShortLinks(userId: string, allowed: boolean): Promise<void> {
  await requireAdmin();
  await db.update(users).set({ allowRootShortLinks: allowed }).where(eq(users.id, userId));
  revalidatePath("/dashboard/admin");
}

/**
 * Folder that new uploads land in. null clears it.
 *
 * Ownership is verified server-side: the select is populated from the user's
 * own folders, but a hand-crafted call must not be able to point their uploads
 * at somebody else's tree.
 */
export async function updateDefaultFolder(folderId: string | null): Promise<{ ok: boolean }> {
  const session = await requireUser();

  if (folderId) {
    const owned = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.ownerId, session.user.id)))
      .limit(1);
    if (!owned[0]) return { ok: false };
  }

  await db.update(users).set({ defaultFolderId: folderId }).where(eq(users.id, session.user.id));
  revalidatePath("/dashboard/profile");
  return { ok: true };
}

export interface NamingPrefs {
  scheme: NamingScheme;
  pattern: string | null;
  wordCount: number;
  randomLength: number;
}

export interface UrlPrefs extends NamingPrefs {
  /** Stored preference, or null when the account follows the default. */
  preferredDomain: string | null;
  /** The origin actually used to build this user's links right now. */
  baseUrl: string;
}

/**
 * URL/naming preferences for the profile page.
 *
 * These columns are not part of Better Auth's session payload, so a server
 * component has to read them explicitly. Exposed as an action rather than a
 * plain helper because this module is `"use server"` — every export here has to
 * be an async function.
 */
export async function myUrlPrefs(): Promise<UrlPrefs> {
  const session = await requireUser();
  const rows = await db
    .select({
      namingScheme: users.namingScheme,
      namingPattern: users.namingPattern,
      namingWordCount: users.namingWordCount,
      namingRandomLength: users.namingRandomLength,
      preferredDomain: users.preferredDomain,
    })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  const row = rows[0];
  const preferredDomain = row?.preferredDomain ?? null;

  return {
    scheme: isNamingScheme(row?.namingScheme) ? row.namingScheme : "random",
    pattern: row?.namingPattern ?? null,
    wordCount: clampWordCount(row?.namingWordCount),
    randomLength: clampRandomLength(row?.namingRandomLength),
    preferredDomain,
    baseUrl: userBaseUrl(preferredDomain),
  };
}

export interface UpdateNamingInput {
  scheme: string;
  pattern?: string | null;
  /** Words per code for the `words` scheme (clamped to 2–4). */
  wordCount?: number | null;
  /** Characters per code for `random-chars` (clamped to 5–32). */
  randomLength?: number | null;
}

/**
 * Choose how NEW uploads are named. Existing files keep the code they were
 * created with, so changing this is always safe for links already shared.
 *
 * The two numeric parameters are stored regardless of the active scheme, so
 * flipping between "words" and "random characters" doesn't lose the length the
 * user configured for the other one.
 */
export async function updateNaming(input: UpdateNamingInput): Promise<void> {
  const session = await requireUser();
  const { scheme } = input;
  if (!isNamingScheme(scheme)) throw new Error("Unknown naming scheme");

  const clean = (input.pattern ?? "").trim().slice(0, 120) || null;
  if (scheme === "custom" && !clean) {
    throw new Error("A custom pattern is required for the custom scheme");
  }
  // Reject a pattern that expands to nothing usable, rather than silently
  // falling back to random codes on every upload.
  if (scheme === "custom" && clean) {
    const probe = buildCodeBase({ scheme: "custom", pattern: clean, filename: "example-file.png" });
    if (!probe) throw new Error("That pattern does not produce a usable name");
  }

  await db
    .update(users)
    .set({
      namingScheme: scheme,
      namingPattern: scheme === "custom" ? clean : null,
      namingWordCount: clampWordCount(input.wordCount),
      namingRandomLength: clampRandomLength(input.randomLength),
    })
    .where(eq(users.id, session.user.id));

  revalidatePath("/dashboard/profile");
  revalidatePath("/dashboard");
}

/**
 * Pick which of the deployment's hostnames this account's links are built from.
 *
 * `null` restores the default. The value is validated against
 * `config.appDomains` here as well as when it is read back: it is echoed into
 * ShareX configs, Open Graph tags and copied links, so an origin the operator
 * never configured must never make it out of this function.
 *
 * Nothing already shared is affected — every configured name is served by the
 * same application, indefinitely.
 */
export async function updatePreferredDomain(
  domain: string | null,
): Promise<{ ok: boolean; baseUrl: string }> {
  const session = await requireUser();
  const clean = domain?.trim().replace(/\/+$/, "") || null;

  if (clean && !isKnownDomain(clean)) {
    return { ok: false, baseUrl: userBaseUrl(null) };
  }

  await db.update(users).set({ preferredDomain: clean }).where(eq(users.id, session.user.id));

  // The dashboard renders copy-links from this, and the root layout is where
  // the tokens page picks it up — revalidate broadly rather than one route.
  revalidatePath("/", "layout");

  return { ok: true, baseUrl: userBaseUrl(clean) };
}

// ---------------------------------------------------------------------------
// Default file password
// ---------------------------------------------------------------------------

/** Shortest default file password we accept. */
const MIN_DEFAULT_PASSWORD = 4;

export interface DefaultPasswordState {
  /** A default password is currently set. */
  enabled: boolean;
  /**
   * How many existing files are on the default password right now — the exact
   * number that "apply to files already shared" would rewrite. Drives the
   * warning copy, and hides the option entirely when there is nothing to apply.
   */
  affected: number;
}

export type DefaultPasswordResult =
  | { ok: true; enabled: boolean; updated: number }
  | { ok: false; reason: "too-short" };

/** Current state of the setting, for the profile form. Never returns the hash. */
export async function myDefaultFilePassword(): Promise<DefaultPasswordState> {
  const session = await requireUser();
  const [prefs, affected] = await Promise.all([
    getDefaultPasswordPrefs(session.user.id),
    countFilesOnDefaultPassword(session.user.id),
  ]);
  return { enabled: prefs.enabled, affected };
}

/**
 * Set, replace or clear the password stamped on this account's NEW uploads.
 * `null` (or an empty string) turns the feature off.
 *
 * Every one of those is a change, so every one of them bumps
 * `default_password_version`. That counter is signed into the "remember for 30
 * days" cookies handed to recipients, so bumping it is what withdraws their
 * remembered consent: nothing uploaded from here on will match a cookie minted
 * before the change.
 *
 * Files already uploaded are left alone unless `applyToExisting` says otherwise
 * — see below. Each carries its own hash, so by default a rotation only governs
 * what is uploaded from here on and never changes the password of a link that
 * is already in somebody's hands.
 *
 * With `applyToExisting`, every file stamped with a PREVIOUS generation of the
 * default is rewritten to the new one: same links, new password. Three
 * properties make that safe to offer:
 *
 *  - a hand-picked password stores `password_version = null`, so it is not in
 *    the set and cannot be trampled by an account-wide rotation;
 *  - a file with no password at all is likewise untouched, so this can never
 *    turn an open link into a gated one behind the owner's back;
 *  - the rewritten rows take the NEW generation number, so every remembered
 *    consent handed to a recipient stops matching them - which is the point.
 *    Anyone holding an old link has to be told the new password.
 *
 * Both writes share one transaction: a bumped counter with the uploads left on
 * the old hash would leave files claiming a generation whose password nobody
 * can produce.
 *
 * Irreversible by construction. Hashes are one-way, so the previous password
 * cannot be restored afterwards - only re-entered from memory.
 */
export async function updateDefaultFilePassword(
  password: string | null,
  applyToExisting = false,
): Promise<DefaultPasswordResult> {
  const session = await requireUser();
  const clean = typeof password === "string" ? password : "";

  if (clean.length > 0 && clean.length < MIN_DEFAULT_PASSWORD) {
    return { ok: false, reason: "too-short" };
  }

  const defaultPasswordHash = clean.length > 0 ? await hashPassword(clean) : null;
  let updated = 0;

  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({
        defaultPasswordHash,
        defaultPasswordVersion: sql`coalesce(${users.defaultPasswordVersion}, 0) + 1`,
      })
      .where(eq(users.id, session.user.id))
      .returning({ version: users.defaultPasswordVersion });

    if (!row) throw new Error("Account not found");

    if (!applyToExisting) return;

    // Clearing the default un-protects the files that were on it: "stop
    // password-protecting my uploads, including the ones already out there" is
    // the only coherent reading of the switch plus the checkbox.
    const rewritten = await tx
      .update(uploads)
      .set({
        passwordHash: defaultPasswordHash,
        passwordVersion: defaultPasswordHash === null ? null : row.version,
      })
      .where(and(eq(uploads.ownerId, session.user.id), isNotNull(uploads.passwordVersion)))
      .returning({ id: uploads.id });

    updated = rewritten.length;
  });

  revalidatePath("/dashboard/profile");
  revalidatePath("/dashboard");
  return { ok: true, enabled: defaultPasswordHash !== null, updated };
}

// ---------------------------------------------------------------------------
// Wallpaper
// ---------------------------------------------------------------------------

export interface BackgroundState {
  /** Public URL of the current wallpaper, or null. */
  url: string | null;
  /** Veil strength, 0-100. */
  dim: number;
}

/** Current wallpaper state, for the profile form. */
export async function myBackground(): Promise<BackgroundState> {
  const session = await requireUser();
  const rows = await db
    .select({
      userCode: users.userCode,
      key: users.backgroundKey,
      dim: users.backgroundDim,
    })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  const row = rows[0];
  return {
    url: backgroundUrl(row?.userCode, row?.key),
    dim: clampDim(row?.dim ?? DIM_DEFAULT),
  };
}

/**
 * How strongly the skin's own background colour veils the wallpaper.
 *
 * The image itself is written by app/api/background/route.ts (a route handler,
 * because Server Actions cap the request body at 1 MB); this is just a number,
 * so it belongs here with the rest of the preferences.
 */
export async function updateBackgroundDim(dim: number): Promise<{ dim: number }> {
  const session = await requireUser();
  const value = clampDim(dim);
  await db.update(users).set({ backgroundDim: value }).where(eq(users.id, session.user.id));
  // <html> carries the wallpaper variables, and those are emitted by the ROOT
  // layout - revalidating only the profile page would leave the old veil.
  revalidatePath("/", "layout");
  return { dim: value };
}

/** Opt in/out of the public profile gallery at /u/{tag}. */
export async function updatePublicProfile(enabled: boolean): Promise<void> {
  const session = await requireUser();
  await db.update(users).set({ publicProfile: enabled }).where(eq(users.id, session.user.id));
  revalidatePath("/dashboard/profile");
}

// `saveSettings` used to live here, writing `register_enabled` from a generic
// key/value form. It was replaced by app/actions/registration.ts, which owns the
// registration gate and its key together, and nothing has called it since.
//
// Deleted rather than left in place: every exported function in a "use server"
// module is a live POST endpoint, whether or not any page renders a button for
// it. Dead code in a normal module is clutter; dead code here is attack surface
// that no reader is checking any more.

// ---------------------------------------------------------------------------
// Admin → Users
//
// Every action below re-checks the admin role on the server. The panel hides
// these controls from non-admins, but a Server Action is a public POST endpoint
// — the UI is not the authorisation boundary.
// ---------------------------------------------------------------------------

/**
 * The user table for Admin → Users, joined with the two numbers an operator
 * actually needs: how much disk the account occupies and how many live files it
 * holds.
 *
 * The file counts come from one grouped scan rather than a correlated subquery
 * per row — production carries 8.6k uploads across 7 accounts, and this keeps
 * the page at two indexed queries no matter how many accounts exist.
 */
export async function listAdminUsers(): Promise<AdminUserRow[]> {
  await requireAdmin();

  const [rows, counts, invited] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
        role: users.role,
        banned: users.banned,
        createdAt: users.createdAt,
        tag: users.userCode,
        image: users.image,
        usedQuota: users.usedQuota,
        maxQuota: users.maxQuota,
        allowRootShortLinks: users.allowRootShortLinks,
      })
      .from(users)
      .orderBy(asc(users.createdAt)),
    db
      .select({ ownerId: uploads.ownerId, files: sql<number>`count(*)::int` })
      .from(uploads)
      .where(isNull(uploads.deletedAt))
      .groupBy(uploads.ownerId),
    // One query for the whole table rather than one per row: the badge is
    // cosmetic and must not cost a round trip per account.
    pendingInviteUserIds(),
  ]);

  const byOwner = new Map(counts.map((c) => [c.ownerId, Number(c.files)]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role ?? null,
    banned: r.banned ?? false,
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    tag: r.tag ?? null,
    avatar: avatarUrl(r.tag, r.image),
    usedQuota: Number(r.usedQuota ?? 0),
    maxQuota: Number(r.maxQuota ?? UNLIMITED_QUOTA),
    files: byOwner.get(r.id) ?? 0,
    allowRootShortLinks: r.allowRootShortLinks ?? false,
    emailVerified: r.emailVerified ?? false,
    invitePending: invited.has(r.id),
  }));
}

/**
 * Set an account's disk limit, in bytes. `-1` means unlimited.
 *
 * The value lands in a bigint column: real installs run past int4's 2.14 GB
 * ceiling immediately (production has a 20 GiB account), so nothing on this
 * path may narrow to a 32-bit int.
 */
export async function setUserQuota(userId: string, bytes: number): Promise<{ ok: boolean }> {
  await requireAdmin();
  if (!Number.isFinite(bytes) || !Number.isSafeInteger(Math.round(bytes))) return { ok: false };

  const value = bytes < 0 ? UNLIMITED_QUOTA : Math.round(bytes);
  await db.update(users).set({ maxQuota: value }).where(eq(users.id, userId));

  revalidatePath("/dashboard/admin");
  return { ok: true };
}

/**
 * Change another account's tag — the first URL segment of every file it owns.
 *
 * Same rules as the self-service version in the profile: validated charset,
 * reserved words refused, and the outgoing tag parked in `user_code_aliases` so
 * the links already in circulation keep resolving. An admin gets no shortcut
 * here; handing over a retired tag would silently redirect someone else's old
 * links into this account's namespace.
 */
export async function setUserTag(
  userId: string,
  tag: string,
): Promise<{ ok: true; tag: string } | { ok: false; reason: TagIssue }> {
  await requireAdmin();
  const clean = tag.trim();

  const check = checkTag(clean);
  if (!check.ok) return { ok: false, reason: check.reason! };

  const target = await db
    .select({ id: users.id, userCode: users.userCode })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target[0]) return { ok: false, reason: "error" };

  const current = target[0].userCode ?? null;
  if (current && clean === current) return { ok: true, tag: clean };

  try {
    await db.transaction(async (tx) => {
      const owner = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.userCode, clean))
        .limit(1);
      if (owner[0] && owner[0].id !== userId) throw new TagConflict("taken");

      const alias = await tx
        .select({ userId: userCodeAliases.userId })
        .from(userCodeAliases)
        .where(eq(userCodeAliases.code, clean))
        .limit(1);
      if (alias[0] && alias[0].userId !== userId) throw new TagConflict("retired");

      if (current) {
        await tx
          .insert(userCodeAliases)
          .values({ code: current, userId })
          .onConflictDoNothing();
      }

      await tx.update(users).set({ userCode: clean }).where(eq(users.id, userId));
    });
  } catch (err) {
    if (err instanceof TagConflict) return { ok: false, reason: err.reason };
    return { ok: false, reason: "error" };
  }

  revalidatePath("/dashboard/admin");
  revalidatePath("/dashboard");
  return { ok: true, tag: clean };
}

/**
 * Recompute `used_quota` from the files that actually exist.
 *
 * The counter is maintained incrementally on upload and on permanent delete, so
 * it drifts if a row is ever removed out-of-band (a failed finalize, a manual
 * DB fix, a bulk import). Trashed files are counted deliberately — they
 * still occupy disk until they are purged.
 */
export async function recalculateUserQuota(userId: string): Promise<{ used: number }> {
  await requireAdmin();

  const [agg] = await db
    .select({ total: sql<string>`coalesce(sum(${uploads.size}), 0)` })
    .from(uploads)
    .where(eq(uploads.ownerId, userId));

  const used = Number(agg?.total ?? 0);
  await db.update(users).set({ usedQuota: used }).where(eq(users.id, userId));

  revalidatePath("/dashboard/admin");
  return { used };
}

/**
 * Why nothing was signed out. The client turns these into copy - a message
 * thrown from a Server Action is masked in production, so anything the user
 * has to read travels as data.
 */
export type RevokeSessionOutcome = "ok" | "current" | "gone" | "error";

/**
 * Sign out ONE of the caller's own sessions.
 *
 * Two things are load-bearing here. The id is resolved to a token through
 * `mySessionToken`, which only ever looks inside the caller's own list, so this
 * cannot reach another account's session - an administrator included. And the
 * revocation itself goes through Better Auth's endpoint rather than a DELETE of
 * our own, so the session is gone everywhere Better Auth would look for it
 * instead of merely gone from the table.
 *
 * The current session is refused rather than revoked. Signing yourself out from
 * a list where every row looks alike is the one mistake this screen can cause,
 * and "Sign out" in the account menu is right there for when it is meant.
 */
export async function revokeMySession(id: string): Promise<{ outcome: RevokeSessionOutcome }> {
  const session = await requireUser();
  if (typeof id !== "string" || !id.trim()) return { outcome: "gone" };
  if (id === session.session.id) return { outcome: "current" };

  const token = await mySessionToken(id);
  if (!token) return { outcome: "gone" };

  try {
    await auth.api.revokeSession({ headers: await headers(), body: { token } });
  } catch {
    return { outcome: "error" };
  }

  revalidatePath("/dashboard/profile");
  return { outcome: "ok" };
}

/**
 * Sign out every session except this one.
 *
 * The count is taken BEFORE the call because Better Auth answers with a bare
 * `{ status: true }`: without this the panel could only say "done", and "3 other
 * devices signed out" is the part that tells the owner whether the number
 * matched what they expected.
 */
export async function revokeMyOtherSessions(): Promise<{ ok: boolean; revoked: number }> {
  await requireUser();

  const others = (await listMySessions()).filter((s) => !s.current).length;
  if (others === 0) return { ok: true, revoked: 0 };

  try {
    await auth.api.revokeOtherSessions({ headers: await headers() });
  } catch {
    return { ok: false, revoked: 0 };
  }

  revalidatePath("/dashboard/profile");
  return { ok: true, revoked: others };
}
