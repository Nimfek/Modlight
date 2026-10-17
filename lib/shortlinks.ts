import "server-only";
import { cookies } from "next/headers";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { shortLinks } from "@/lib/db/schema";
import { config } from "@/lib/config";
import { hashPassword, unlockCookieName, verifyUnlockToken } from "@/lib/password";
import { getUserPrefs, mayCreateRootShortLink } from "@/lib/data/user-prefs";
import { humanCode, slugify } from "@/lib/ids";
import { scopedShortCode, SHORT_CODE_MAX } from "@/lib/naming";

/**
 * Short links: minting them, and resolving them.
 *
 * Minting lives here rather than in the Server Action because it has two callers
 * now — the panel's action and `POST /api/shortlinks`, which the desktop client
 * uses to turn whatever is on the clipboard into a link. `normalizeTarget` below
 * is a SECURITY CONTROL, not a convenience: a shortener that will redirect to a
 * `javascript:` URL is an XSS vector on whichever domain serves it. A security
 * control with two implementations eventually has one implementation and a hole,
 * so there is exactly one here and both entry points go through it.
 */

// ---------------------------------------------------------------------------
// Result vocabulary
// ---------------------------------------------------------------------------

/**
 * Why a short link could not be created. Travels as data, not as a thrown
 * error: Next masks Server Action error messages in production, so anything the
 * user has to read would arrive as "an error occurred".
 *
 * The HTTP surface maps these to status codes (app/api/shortlinks/route.ts), so
 * adding a member means deciding what it means over the wire as well.
 */
export type ShortLinkIssue =
  | "invalid-url"
  | "invalid-code"
  | "code-taken"
  | "code-too-long"
  | "root-not-allowed"
  | "no-tag"
  | "error";

export type CreateShortLinkResult =
  | { ok: true; code: string; url: string }
  | { ok: false; reason: ShortLinkIssue };

export interface CreateShortLinkInput {
  target: string;
  customCode?: string;
  expiresInDays?: number | null;
  password?: string;
  /**
   * Prefix the link with the owner's tag: /s/{userCode}/{code}. Defaults to
   * true — the prefix is what gives every user their own namespace, so opting
   * out claims a slot in the global root namespace and is a privilege.
   */
  useUserCode?: boolean;
}

// ---------------------------------------------------------------------------
// Input limits
// ---------------------------------------------------------------------------

/**
 * Longest raw target this will even try to parse.
 *
 * `short_links.target` is a `text` column, so Postgres would accept a megabyte
 * quite happily — and now that a token holder can POST here without a form in
 * the way, "the column has no limit" stops being a fact about the schema and
 * becomes an invitation. 4 KiB clears every real URL (a signed S3 link runs to
 * about 1.5 KiB) while keeping a stored redirect target a redirect target.
 */
const TARGET_MAX = 4096;

/**
 * Longest raw custom code accepted before slugifying.
 *
 * The stored form is capped at `SHORT_CODE_MAX` anyway, so this only saves the
 * work of slugifying something absurd. Refused as `code-too-long` because that
 * is what it is, and the panel already has the right sentence for it.
 */
const CUSTOM_CODE_MAX = 256;

/** Longest expiry a caller may ask for, in days (10 years). */
const EXPIRY_MAX_DAYS = 3650;

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Target normalisation (the security control)
// ---------------------------------------------------------------------------

/**
 * Accept what people actually type.
 *
 * `google.pl` and `www.google.pl` are what someone pastes when shortening a
 * link; demanding `https://` is a papercut with no upside, since the value is
 * only ever used as a redirect target. A bare host is promoted to `https://`
 * (not `http://` — defaulting to plaintext would silently downgrade the link).
 *
 * Returns the normalised absolute URL, or null when it cannot be made into one.
 */
export function normalizeTarget(raw: string): string | null {
  // Length before trim: refusing by looking at `.length` is free, where
  // trimming a multi-megabyte string copies it first.
  if (raw.length > TARGET_MAX) return null;

  const input = raw.trim();
  if (!input) return null;

  // Reject anything carrying a non-web scheme outright — `javascript:` and
  // `data:` in a redirect target are how a shortener becomes an XSS vector.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(input);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") return null;
  }

  const candidate = schemeMatch ? input : `https://${input}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // A hostname with no dot and no port is almost certainly a typo rather than
    // an intranet name, and silently shortening to nowhere helps no one.
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Days from now to an absolute expiry, or null for "never".
 *
 * Clamped rather than trusted, because this now takes a number straight off the
 * wire. `Date.now() + 1e308 * 86_400_000` is `Infinity`, `new Date(Infinity)` is
 * an Invalid Date, and Postgres rejects that — which the insert's catch would
 * have reported as `code-taken`, sending a client off to pick a different code
 * for a problem that had nothing to do with the code.
 *
 * Non-positive and non-finite values mean "never" rather than "born expired":
 * the panel's dropdown cannot produce one, and a link that is dead on arrival is
 * nobody's intent.
 */
export function expiryFromDays(days: number | null | undefined): Date | null {
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + Math.min(days, EXPIRY_MAX_DAYS) * MS_PER_DAY);
}

/**
 * Absolute short link. Built from SHORTLINK_URL when set (production points it
 * at the dedicated shortener domain) and from APP_URL otherwise — the same app
 * answers on both, so older links built on APP_URL keep resolving.
 */
export function shortLinkUrl(stored: string): string {
  // On a dedicated shortener domain the code is the whole path — that is the
  // point of having one. proxy.ts rewrites /{code} back onto /s/{code}, so the
  // routes stay single-sourced and links minted before this keep resolving.
  if (config.shortUrl !== config.appUrl) return `${config.shortUrl}/${stored}`;
  return `${config.appUrl}/s/${stored}`;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

async function isCodeTaken(stored: string): Promise<boolean> {
  const hit = await db
    .select({ id: shortLinks.id })
    .from(shortLinks)
    .where(eq(shortLinks.code, stored))
    .limit(1);
  return hit.length > 0;
}

/** Random leaf, unique within the scope it will be stored under. */
async function uniqueCode(tag: string | null): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const c = humanCode(7);
    if (!(await isCodeTaken(scopedShortCode(tag, c)))) return c;
  }
  throw new Error("Could not allocate a unique code");
}

/**
 * Postgres `unique_violation`, as surfaced by node-postgres on the thrown error.
 *
 * Worth telling apart: the insert used to report EVERY failure as `code-taken`,
 * so a connection blip advised the caller to pick a different code. A human
 * shrugs and retries; a desktop client mapping `code-taken` to 409 would loop
 * through fresh codes forever against a problem that was never about the code.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505"
  );
}

/**
 * Mint a short link for `ownerId`.
 *
 * The whole decision, minus the two things that differ per caller: how the
 * caller was authenticated (session vs API token) and whether a cache needs
 * revalidating afterwards. Everything that can refuse the request is here, so
 * the panel and the HTTP surface cannot drift into disagreeing about what is
 * allowed.
 */
export async function createShortLinkFor(
  ownerId: string,
  input: CreateShortLinkInput,
): Promise<CreateShortLinkResult> {
  const target = normalizeTarget(input.target);
  if (!target) return { ok: false, reason: "invalid-url" };

  const prefs = await getUserPrefs(ownerId);
  if (!prefs) return { ok: false, reason: "error" };

  // Scope. Enforced here rather than in the form: the checkbox is only a hint
  // about what the server will accept.
  const wantsPrefix = input.useUserCode !== false;
  let tag: string | null;
  if (wantsPrefix) {
    if (!prefs.userCode) return { ok: false, reason: "no-tag" };
    tag = prefs.userCode;
  } else {
    if (!mayCreateRootShortLink(prefs)) return { ok: false, reason: "root-not-allowed" };
    tag = null;
  }

  const custom = input.customCode?.trim();
  let code: string;
  if (custom) {
    if (custom.length > CUSTOM_CODE_MAX) return { ok: false, reason: "code-too-long" };
    code = slugify(custom);
    if (!code) return { ok: false, reason: "invalid-code" };
  } else {
    code = await uniqueCode(tag);
  }

  const stored = scopedShortCode(tag, code);
  // short_links.code is varchar(64); the scoped form has to fit.
  if (stored.length > SHORT_CODE_MAX) return { ok: false, reason: "code-too-long" };
  if (custom && (await isCodeTaken(stored))) return { ok: false, reason: "code-taken" };

  const password = input.password?.trim();
  const passwordHash = password ? await hashPassword(password) : null;
  const expiresAt = expiryFromDays(input.expiresInDays);

  try {
    await db.insert(shortLinks).values({ ownerId, code: stored, target, expiresAt, passwordHash });
  } catch (err) {
    // Unique index race: somebody claimed the code between check and insert.
    if (isUniqueViolation(err)) return { ok: false, reason: "code-taken" };
    return { ok: false, reason: "error" };
  }

  return { ok: true, code: stored, url: shortLinkUrl(stored) };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a stored short-link code to its redirect.
 *
 * `stored` is the value in short_links.code, which for a namespaced link is
 * "{tag}/{code}" — so /s/{tag}/{code} and /s/{code} are the same lookup and
 * share this one implementation (click counting, expiry, password gate).
 */
export async function redirectShortLink(stored: string): Promise<Response> {
  const rows = await db.select().from(shortLinks).where(eq(shortLinks.code, stored)).limit(1);
  const link = rows[0];
  if (!link) return new Response("Not found", { status: 404 });
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    return new Response("This link has expired", { status: 410 });
  }

  // Password gate: unless a valid signed unlock token is present, send to the
  // gate page. The cookie is client-controlled, so only its signature counts.
  if (link.passwordHash) {
    const jar = await cookies();
    const token = jar.get(unlockCookieName("shortlink", link.id))?.value;
    if (!verifyUnlockToken(token, "shortlink", link.id)) {
      // `stored` may contain a slash; it is already a path, so it must not be
      // percent-encoded as a whole or the gate would land on a 404.
      return Response.redirect(`${config.appUrl}/s/${stored}/unlock`, 302);
    }
  }

  void db
    .update(shortLinks)
    .set({ clicks: sql`${shortLinks.clicks} + 1`, lastUsedAt: new Date() })
    .where(eq(shortLinks.id, link.id))
    .catch(() => {});

  return Response.redirect(link.target, 302);
}
