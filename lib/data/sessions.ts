import "server-only";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

/**
 * Active sign-ins for the current account, for /dashboard/profile.
 *
 * Better Auth owns the `session` table, so everything here goes through its own
 * endpoints (`/list-sessions`, `/revoke-session`, `/revoke-other-sessions`)
 * rather than through Drizzle. That is not politeness: deleting a row underneath
 * it would leave the cookie cache, the session hooks and any future secondary
 * storage believing the session is still alive, so a session could read as
 * "revoked" on this screen while its cookie carried on working.
 *
 * `/list-sessions` is scoped to the CALLER by Better Auth's own session
 * middleware, which is also the entire authorisation story for this file: there
 * is no code path here that can be handed somebody else's user id, so an
 * administrator gets their own devices on this screen and nobody else's.
 */

/** What kind of thing is holding the session, as far as it will admit. */
export type DeviceKind = "desktop" | "mobile" | "tablet" | "client" | "unknown";

export interface DeviceLabel {
  /** Browser name plus major version, or null when we cannot tell. */
  browser: string | null;
  /** Operating system, only as precisely as the string honestly says. */
  os: string | null;
  kind: DeviceKind;
}

export interface SessionView {
  /** Row id. Deliberately NOT the session token - see `mySessionToken`. */
  id: string;
  /** True for the session that is rendering this page. */
  current: boolean;
  /** ISO. When this session was created, i.e. when someone signed in. */
  createdAt: string;
  /**
   * ISO. When Better Auth last renewed the session.
   *
   * This is NOT a last-seen time and must never be labelled as one: the session
   * row is only written when it enters the last `updateAge` of its life (one day
   * by default), so a device used every hour still stamps this once. Better Auth
   * records no per-request timestamp, and inventing one would mean a write on
   * every authenticated request.
   */
  renewedAt: string;
  /** ISO. When the session stops working on its own. */
  expiresAt: string;
  /** Client address as the reverse proxy reported it, or null. */
  ip: string | null;
  /**
   * The raw User-Agent, clipped. Attacker-controlled free text: render it as
   * TEXT and nothing else - never into markup, a URL, or an attribute that is
   * interpreted. React escapes text and attributes, which is why it is safe in
   * a `<span>` and would not be inside `dangerouslySetInnerHTML`.
   */
  userAgent: string | null;
  device: DeviceLabel;
  /** Admin plugin: this session was opened by someone impersonating the user. */
  impersonated: boolean;
}

/** A User-Agent longer than this is noise; nothing legitimate needs it. */
const MAX_UA = 300;

/**
 * Non-browser clients, checked first: several of them also carry a browser
 * token to get past naive sniffing, and "curl" is a more useful answer than
 * "Chrome 120".
 */
const CLIENTS: [RegExp, string][] = [
  [/Modlight[/ ]?([\d.]+)?/i, "Modlight App"],
  [/ShareX[/ ]?([\d.]+)?/i, "ShareX"],
  [/curl\/([\d.]+)/i, "curl"],
  [/Wget\/([\d.]+)/i, "Wget"],
  [/python-requests\/([\d.]+)/i, "python-requests"],
  [/PostmanRuntime\/([\d.]+)/i, "Postman"],
  [/insomnia\/([\d.]+)/i, "Insomnia"],
  [/okhttp\/([\d.]+)/i, "OkHttp"],
  [/Go-http-client\/([\d.]+)/i, "Go"],
  [/PowerShell\/([\d.]+)/i, "PowerShell"],
];

/**
 * Browsers, in the only order that works.
 *
 * Every Chromium browser still ships "Chrome/" in its string, and every one of
 * them ships "Safari/" as well, so the specific names have to be tried before
 * the generic ones or Edge and Opera both come out as Chrome. Brave removed its
 * own token on purpose and is genuinely indistinguishable from Chrome, so it is
 * reported as Chrome rather than guessed at.
 */
const BROWSERS: [RegExp, string][] = [
  [/Edg(?:iOS|A)?\/(\d+)/, "Edge"],
  [/OPR\/(\d+)/, "Opera"],
  [/Opera\/(\d+)/, "Opera"],
  [/Vivaldi\/(\d+)/, "Vivaldi"],
  [/SamsungBrowser\/(\d+)/, "Samsung Internet"],
  [/(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
  [/(?:CriOS|Chrome)\/(\d+)/, "Chrome"],
  [/Version\/(\d+)[\d.]*(?: Mobile\/\S+)? Safari/, "Safari"],
];

/**
 * The operating system, claimed only as far as the string is honest.
 *
 * Windows NT 10.0 is reported by Windows 10 AND Windows 11 - Microsoft never
 * moved the token - so this says "Windows" rather than picking one. macOS has
 * been frozen at 10_15_7 in every browser since 2021 for fingerprinting
 * reasons, so it gets no version either. Android and iOS do report the real
 * number, so those are shown.
 */
function osOf(ua: string): string | null {
  const nt = /Windows NT ([\d.]+)/.exec(ua);
  if (nt) {
    if (nt[1] === "6.1") return "Windows 7";
    if (nt[1] === "6.2") return "Windows 8";
    if (nt[1] === "6.3") return "Windows 8.1";
    return "Windows";
  }
  // CrOS and Android both contain "Linux", so they have to be tested first.
  if (/CrOS/.test(ua)) return "ChromeOS";
  const android = /Android (\d+)/.exec(ua);
  if (android) return `Android ${android[1]}`;
  const ios = /(?:iPhone|iPad|iPod)[^)]*?OS (\d+)[._]/.exec(ua);
  if (ios) return `iOS ${ios[1]}`;
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux|X11/.test(ua)) return "Linux";
  return null;
}

function kindOf(ua: string, os: string | null): DeviceKind {
  // An Android tablet is an Android UA WITHOUT the "Mobile" token; that is the
  // documented difference, and the only one there is.
  if (/iPad|Tablet|Android(?!.*Mobile)/.test(ua)) return "tablet";
  if (/Mobile|iPhone|iPod|Android/.test(ua)) return "mobile";
  if (os) return "desktop";
  return "unknown";
}

/**
 * Best honest reading of a User-Agent. Pure, so it is unit-testable and so
 * nothing about it can reach the database.
 *
 * Anything it cannot identify comes back as null rather than as a guess: a
 * wrong device name on this screen is worse than no name, because the whole
 * point of the list is deciding whether a session is yours.
 */
export function describeDevice(ua: string | null | undefined): DeviceLabel {
  const raw = (ua ?? "").trim();
  if (!raw) return { browser: null, os: null, kind: "unknown" };

  for (const [re, name] of CLIENTS) {
    const m = re.exec(raw);
    if (m) return { browser: m[1] ? `${name} ${m[1]}` : name, os: osOf(raw), kind: "client" };
  }

  let browser: string | null = null;
  for (const [re, name] of BROWSERS) {
    const m = re.exec(raw);
    if (m) {
      browser = m[1] ? `${name} ${m[1]}` : name;
      break;
    }
  }

  const os = osOf(raw);
  return { browser, os, kind: kindOf(raw, os) };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Every live session on the caller's own account, current one first.
 *
 * Better Auth hands back the session TOKEN as part of each row. It never leaves
 * this function: the token is the credential the cookie carries, so shipping it
 * to the browser would turn this screen into a way to copy a sign-in out of the
 * page source. The row id is enough to name a session, and `mySessionToken`
 * turns it back into a token on the server when one is actually needed.
 */
export async function listMySessions(): Promise<SessionView[]> {
  const h = await headers();
  const [current, rows] = await Promise.all([
    auth.api.getSession({ headers: h }),
    auth.api.listSessions({ headers: h }),
  ]);

  const currentId = current?.session.id ?? null;

  const views = rows.map((row): SessionView => {
    const ua = row.userAgent ? row.userAgent.slice(0, MAX_UA) : null;
    return {
      id: row.id,
      current: row.id === currentId,
      createdAt: iso(row.createdAt),
      renewedAt: iso(row.updatedAt),
      expiresAt: iso(row.expiresAt),
      ip: row.ipAddress && row.ipAddress.trim() ? row.ipAddress.trim().slice(0, 64) : null,
      userAgent: ua,
      device: describeDevice(ua),
      impersonated: Boolean((row as { impersonatedBy?: string | null }).impersonatedBy),
    };
  });

  // This device first, then the most recently started sign-in.
  return views.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/**
 * The Better Auth token for one of the CALLER'S OWN sessions, or null.
 *
 * This is the ownership check for revocation, and it is structural rather than
 * a comparison somebody has to remember to write: the id is looked up in the
 * caller's own list, so an id belonging to another account simply is not found.
 * An administrator has no more reach here than anyone else.
 */
export async function mySessionToken(id: string): Promise<string | null> {
  if (!id) return null;
  const rows = await auth.api.listSessions({ headers: await headers() });
  return rows.find((row) => row.id === id)?.token ?? null;
}
