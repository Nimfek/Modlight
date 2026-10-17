import "server-only";
import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { folders, uploads, user as users } from "@/lib/db/schema";
import { DIM_DEFAULT } from "@/lib/background";

/**
 * Per-user URL/upload preferences.
 *
 * These columns are deliberately NOT exposed through Better Auth's
 * `additionalFields`, so `session.user` does not carry them — read them here
 * instead. Keeping them out of the session also means a change takes effect on
 * the next request instead of waiting for the session cookie to be refreshed.
 */
export interface UserPrefs {
  id: string;
  role: string | null;
  /** Current tag = first URL segment. */
  userCode: string | null;
  /** Admin-only: generate links without the tag segment. */
  skipTagInUrl: boolean;
  /** May create short links at the root of the shortener domain. */
  allowRootShortLinks: boolean;
  /** Folder new uploads land in (null = none). */
  defaultFolderId: string | null;
  /**
   * Hostname this user's links are generated with (null = deployment default).
   * Resolve it through `userBaseUrl()` — the stored value is only honoured when
   * it is still one of `config.appDomains`.
   */
  preferredDomain: string | null;
  /** Storage key of the account's wallpaper (null = none). */
  backgroundKey: string | null;
  /** Veil strength over the wallpaper, 0-100. */
  backgroundDim: number;
}

export async function getUserPrefs(userId: string): Promise<UserPrefs | null> {
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      userCode: users.userCode,
      skipTagInUrl: users.skipTagInUrl,
      allowRootShortLinks: users.allowRootShortLinks,
      defaultFolderId: users.defaultFolderId,
      preferredDomain: users.preferredDomain,
      backgroundKey: users.backgroundKey,
      backgroundDim: users.backgroundDim,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    skipTagInUrl: Boolean(row.skipTagInUrl),
    allowRootShortLinks: Boolean(row.allowRootShortLinks),
    backgroundDim: row.backgroundDim ?? DIM_DEFAULT,
  };
}

/** State of the "password-protect my new uploads" setting. */
export interface DefaultPasswordPrefs {
  /** A default password is set (there is no separate on/off flag). */
  enabled: boolean;
  /** Generation counter, bumped on every change. Stamped onto new uploads. */
  version: number;
}

/**
 * Read the owner's default-password setting.
 *
 * Never returns the hash: nothing outside the upload pipeline and the change
 * form has any business with it, and this feeds a client component.
 */
export async function getDefaultPasswordPrefs(userId: string): Promise<DefaultPasswordPrefs> {
  const rows = await db
    .select({
      hash: users.defaultPasswordHash,
      version: users.defaultPasswordVersion,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  return { enabled: !!row?.hash, version: row?.version ?? 0 };
}

/**
 * How many of this account's uploads currently carry the DEFAULT password —
 * i.e. exactly the set that "apply to files already shared" would rewrite.
 *
 * `password_version IS NOT NULL` is the whole definition: a file with a
 * hand-picked password stores null there, and so does a file with no password
 * at all, so neither is counted and neither is ever touched.
 *
 * Trashed files are deliberately included. They still exist and can be
 * restored, so leaving them on the old password would quietly resurrect it —
 * and the number shown to the user has to be the number of rows the update
 * actually writes, or the confirmation is lying about its own blast radius.
 */
export async function countFilesOnDefaultPassword(userId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(uploads)
    .where(and(eq(uploads.ownerId, userId), isNotNull(uploads.passwordVersion)));

  return rows[0]?.n ?? 0;
}

/** What a new upload records when it takes the account's default password. */
export interface DefaultPasswordStamp {
  passwordHash: string | null;
  /** Generation the hash came from; null when there is no default at all. */
  passwordVersion: number | null;
}

/**
 * Read the default password ready to be copied onto a new row.
 *
 * The hash is copied rather than referenced so that rotating the default does
 * not silently change the password of links already shared - see
 * `updateDefaultFilePassword`, where opting into exactly that is a separate,
 * confirmed choice.
 *
 * This is the one place outside the change form that sees the hash, which is
 * why it is server-only and returns nothing else.
 */
export async function defaultPasswordStamp(userId: string): Promise<DefaultPasswordStamp> {
  const rows = await db
    .select({ hash: users.defaultPasswordHash, version: users.defaultPasswordVersion })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row?.hash) return { passwordHash: null, passwordVersion: null };
  return { passwordHash: row.hash, passwordVersion: row.version ?? 0 };
}

/**
 * The generation of `ownerId`'s default password right now.
 *
 * Used by the password gate to decide which promise the "remember me" checkbox
 * may make: a file stamped with THIS number is on the current account default,
 * so remembering it can be worth 30 days across every such file. Anything else
 * (a hand-picked password, or a file left behind by an earlier default) can
 * only ever be remembered for itself.
 */
export async function getOwnerPasswordVersion(ownerId: string): Promise<number | null> {
  const rows = await db
    .select({ hash: users.defaultPasswordHash, version: users.defaultPasswordVersion })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);

  const row = rows[0];
  if (!row?.hash) return null;
  return row.version ?? 0;
}

/**
 * Folder that new uploads should land in, or null.
 *
 * Verifies the folder still belongs to the user: a stale id (folder deleted
 * outside the FK path, or moved between accounts by an import) must not send
 * files into someone else's tree — the upload pipeline calls this on every
 * ingest, so failing closed here is cheap insurance.
 */
export async function getDefaultFolderId(userId: string): Promise<string | null> {
  const prefs = await getUserPrefs(userId);
  if (!prefs?.defaultFolderId) return null;

  const rows = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.id, prefs.defaultFolderId), eq(folders.ownerId, userId)))
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * May this user create short links without the /{userCode}/ prefix?
 *
 * The role grants it outright, so `allow_root_short_links` means one thing only:
 * an explicit grant to a REGULAR account. Promoting somebody deliberately does
 * not write the column — otherwise the grant would outlive the demotion and
 * leave an ex-admin holding a permission nobody gave them. Admin → Users mirrors
 * this by showing the switch locked on for admins (components/admin/UserManager.tsx).
 */
export function mayCreateRootShortLink(prefs: Pick<UserPrefs, "role" | "allowRootShortLinks">): boolean {
  return prefs.role === "admin" || prefs.allowRootShortLinks;
}

/**
 * Resolve a ROOT-level (tagless) media link: /{code}.{ext}.
 *
 * Only files whose owner opted into `skipTagInUrl` are reachable this way —
 * otherwise every upload in the system would silently gain a second, shorter
 * URL and the per-user tag namespace would stop meaning anything.
 *
 * Returns the owner's current tag so the caller can delegate to the normal
 * /{tag}/{code} handling (view counting, password gate, expiry, OG tags) with
 * no second implementation to keep in sync.
 */
export async function resolveTaglessOwnerTag(code: string): Promise<string | null> {
  const rows = await db
    .select({ userCode: users.userCode, skipTagInUrl: users.skipTagInUrl })
    .from(uploads)
    .innerJoin(users, eq(users.id, uploads.ownerId))
    .where(and(eq(uploads.code, code), isNull(uploads.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (!row || !row.skipTagInUrl || !row.userCode) return null;
  return row.userCode;
}
