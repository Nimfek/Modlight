import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "@/lib/config";

/**
 * Primitives behind password-gated links (protected files and short links):
 * hashing, the signed cookie that proves a successful unlock, and the throttle
 * on guessing attempts.
 *
 * Framework-agnostic on purpose (no next/headers) so it stays unit-testable and
 * usable from the custom server.
 */

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// Hashing — `scrypt$<saltB64url>$<dkB64url>`
// ---------------------------------------------------------------------------

/**
 * Async on purpose: scrypt is deliberately expensive (~100 ms), and the sync
 * variant blocks the whole event loop, so a handful of concurrent unlock
 * attempts would stall every other request in the process.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${dk.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  try {
    const [scheme, saltB64, dkB64] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(dkB64, "base64url");
    if (expected.length === 0) return false;
    const dk = await scrypt(password, salt, expected.length);
    return expected.length === dk.length && timingSafeEqual(expected, dk);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Unlock tokens
// ---------------------------------------------------------------------------

/**
 * What a token opens:
 *  - `media`     — exactly one file,
 *  - `shortlink` — exactly one short link,
 *  - `owner`     — every file of one owner that carries a given generation of
 *                  that owner's DEFAULT password (see below).
 */
export type UnlockScope = "media" | "shortlink" | "owner";

/** How long a successful unlock stays valid, per scope (seconds). */
const UNLOCK_TTL: Record<UnlockScope, number> = {
  media: 60 * 60 * 24,
  shortlink: 60 * 60,
  owner: 60 * 60 * 24 * 30,
};

/** What "remember this" buys, whatever the scope: 30 days. */
export const REMEMBER_TTL = 60 * 60 * 24 * 30;

/**
 * Proof of a successful unlock: `<expiry>.<HMAC-SHA256(secret, parts|expiry)>`.
 *
 * The value MUST be unforgeable, because cookies are entirely client-controlled
 * — a flag cookie like `ml_unlock_<id>=1` is something any visitor can set for
 * themselves, which makes the password gate decorative. Binding the signature
 * to the resource id also stops a token minted for one file from unlocking
 * another, and to the scope so a short-link token can't unlock a file.
 */
export function mintUnlockToken(
  scope: "media" | "shortlink",
  id: string,
  ttlSeconds: number = UNLOCK_TTL[scope],
): string {
  return mint([scope, id], ttlSeconds);
}

export function verifyUnlockToken(
  token: string | null | undefined,
  scope: "media" | "shortlink",
  id: string,
): boolean {
  return verify(token, [scope, id]);
}

// ---------------------------------------------------------------------------
// Owner-scoped unlock ("remember for 30 days")
// ---------------------------------------------------------------------------

/**
 * A token that opens every file of `ownerId` carrying generation `version` of
 * that owner's default file password.
 *
 * The generation number is INSIDE the signature, which is what makes changing
 * the default password revoke the remembered consent: the owner's counter is
 * bumped on every change, files uploaded afterwards record the new number, and
 * a cookie minted for the old one no longer matches any of them. Nothing about
 * the cookie needs to be tracked server-side for that to hold.
 *
 * Deliberately NOT re-checked against the owner's *current* generation at read
 * time. Files keep the password they were uploaded with (rotating the default
 * must not lock the owner out of links already shared), so a recipient holding
 * an old cookie can only reach files whose password they demonstrably already
 * know — while everything uploaded under the new default stays shut. Requiring
 * the current generation would buy nothing beyond an extra prompt, at the cost
 * of a database read on every raw/download hit.
 */
export function mintOwnerUnlockToken(
  ownerId: string,
  version: number,
  ttlSeconds: number = UNLOCK_TTL.owner,
): string {
  if (!isVersion(version)) throw new Error("mintOwnerUnlockToken: invalid version");
  return mint(ownerParts(ownerId, version), ttlSeconds);
}

export function verifyOwnerUnlockToken(
  token: string | null | undefined,
  ownerId: string | null | undefined,
  version: number | null | undefined,
): boolean {
  if (!ownerId || !isVersion(version)) return false;
  return verify(token, ownerParts(ownerId, version));
}

function ownerParts(ownerId: string, version: number): string[] {
  return ["owner", ownerId, `v${version}`];
}

function isVersion(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** The bits of an upload the unlock decision depends on. */
export interface MediaUnlockSubject {
  /** uploads.id */
  mediaId: string;
  /** uploads.ownerId (null for an orphaned file). */
  ownerId: string | null;
  /**
   * uploads.passwordVersion — the generation of the owner's DEFAULT password
   * this file was created under, or null when its password was set by hand.
   *
   * Null is what keeps a hand-picked password private: an owner-scoped cookie
   * proves the holder knew the *default* password, which says nothing about the
   * one this file actually carries.
   */
  passwordVersion: number | null;
}

/** Reads one cookie value by name. Keeps this module free of next/headers. */
export type CookieReader = (name: string) => string | undefined;

/**
 * Has this visitor cleared the password gate for `subject`?
 *
 * Two ways in, and only these two: a token minted for this exact file, or an
 * owner-scoped token whose generation matches the one the file records.
 */
export function isMediaUnlocked(subject: MediaUnlockSubject, read: CookieReader): boolean {
  const own = read(unlockCookieName("media", subject.mediaId));
  if (verifyUnlockToken(own, "media", subject.mediaId)) return true;

  // Hand-picked password, or an orphan with no owner to scope a token to.
  if (subject.passwordVersion == null || !subject.ownerId) return false;

  return verifyOwnerUnlockToken(
    read(ownerUnlockCookieName(subject.ownerId)),
    subject.ownerId,
    subject.passwordVersion,
  );
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/** Cookie carrying the unlock token for a given resource. */
export function unlockCookieName(scope: UnlockScope, id: string): string {
  if (scope === "media") return `ml_unlock_${id}`;
  if (scope === "shortlink") return `ml_sl_${id}`;
  return `ml_dpw_${id}`;
}

/** Cookie carrying the owner-scoped ("remember for 30 days") token. */
export function ownerUnlockCookieName(ownerId: string): string {
  return unlockCookieName("owner", ownerId);
}

export function unlockCookieOptions(scope: UnlockScope, ttlSeconds?: number) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax" as const,
    secure: config.isProd,
    maxAge: ttlSeconds ?? UNLOCK_TTL[scope],
  };
}

// ---------------------------------------------------------------------------
// Token internals
// ---------------------------------------------------------------------------

function mint(parts: string[], ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${exp}.${sign(parts, exp)}`;
}

function verify(token: string | null | undefined, parts: string[]): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;

  const exp = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(exp) || exp <= 0) return false;
  if (exp * 1000 <= Date.now()) return false;

  return equalStrings(token.slice(dot + 1), sign(parts, exp));
}

/**
 * Each part is percent-encoded before being joined, so a value containing the
 * separator cannot be split differently than it was signed. For the ids we
 * actually use (uuids, Better Auth ids, the scope literals) the encoding is the
 * identity function, which is why tokens minted before the owner scope existed
 * still verify.
 */
function sign(parts: string[], exp: number): string {
  const message = [...parts, String(exp)].map(encodeURIComponent).join("|");
  return createHmac("sha256", config.auth.secret).update(message).digest("base64url");
}

/** Constant-time compare. Length is not secret here (HMACs are fixed-size). */
function equalStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Attempt throttling
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

// Survives HMR in dev; a per-process Map is enough because unlock attempts only
// need to be slowed down, not accounted for exactly across a cluster.
const buckets: Map<string, Bucket> = ((
  globalThis as unknown as { __mlRateBuckets?: Map<string, Bucket> }
).__mlRateBuckets ??= new Map());

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the bucket refills (0 when allowed). */
  retryAfterMs: number;
}

/** Shared result shape of the unlock server actions. */
export interface UnlockResult {
  ok: boolean;
  /** Present when the attempt was refused before the password was even checked. */
  error?: "rate-limited";
  /**
   * What the "remember me" checkbox actually bought, decided on the server:
   * `owner` = every file on this owner's current default password, `file` =
   * this file only, absent = nothing was remembered beyond the usual session.
   */
  remembered?: "owner" | "file";
}

/**
 * Fixed-window limiter for password guessing, keyed by caller + resource.
 * Counts the attempt it is asked about, so a miss on a non-existent resource
 * costs the same as a wrong password (no enumeration signal).
 */
export function checkRateLimit(
  key: string,
  max: number = MAX_ATTEMPTS,
  windowMs: number = WINDOW_MS,
): RateLimitResult {
  const now = Date.now();
  maintain(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }

  bucket.count += 1;
  if (bucket.count > max) return { allowed: false, retryAfterMs: bucket.resetAt - now };
  return { allowed: true, retryAfterMs: 0 };
}

/** Clear the bucket after a successful unlock. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/**
 * Buckets live in process memory, and several keys are built from strings the
 * caller supplies (an address for the resend throttle, an upload code for the
 * unlock one). So the map is somewhere an unauthenticated visitor can put
 * entries, and it needs a ceiling.
 *
 * Sweeping alone is not one. `sweep` only removes buckets that have EXPIRED, so
 * a flood of distinct keys inside a single window leaves every entry live and
 * frees nothing — while the old `size > 5000` test ran that full scan on every
 * subsequent call, turning the flood into CPU load as well as memory.
 */
const BUCKET_SOFT_LIMIT = 5_000;
const BUCKET_HARD_LIMIT = 20_000;
const SWEEP_INTERVAL_MS = 30_000;
let lastSweep = 0;

function maintain(now: number): void {
  if (buckets.size <= BUCKET_SOFT_LIMIT) return;

  // Time-boxed: over the limit the scan is worth doing, but not on every call.
  if (now - lastSweep >= SWEEP_INTERVAL_MS) {
    sweep(now);
    lastSweep = now;
  }

  // Still over the ceiling means the entries are live, so eviction has to
  // choose. A Map iterates in insertion order, which is oldest-first, and the
  // oldest bucket is the one closest to expiring anyway. Evicting it costs an
  // attacker's own bucket far more often than a real user's: filling this map
  // takes twenty thousand distinct keys, and every one of them is younger than
  // what it displaces.
  if (buckets.size > BUCKET_HARD_LIMIT) {
    let over = buckets.size - BUCKET_HARD_LIMIT;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (--over <= 0) break;
    }
  }
}

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Caller identity for throttling. Only `x-real-ip` is trusted: X-Forwarded-For
 * is client-appendable, so honoring it would hand every request a fresh bucket.
 * The reverse proxy must set it (Caddy does by default; nginx needs
 * `proxy_set_header X-Real-IP $remote_addr;`) — without it all callers share one
 * bucket, which throttles harder rather than not at all.
 */
export function clientIp(h: Headers): string {
  return h.get("x-real-ip")?.trim() || "unknown";
}
