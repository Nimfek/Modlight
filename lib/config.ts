/**
 * Centralized runtime configuration, sourced from environment variables.
 * Framework-agnostic on purpose — imported by both the Next app and the custom
 * Node server (server.ts). Branding lives here so the product is rebrandable by
 * changing one env var.
 */

function bool(v: string | undefined, fallback = false): boolean {
  if (v == null) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function int(v: string | undefined, fallback: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ── Secret validation ───────────────────────────────────────────────────────
// Dev keeps working with zero configuration, production refuses to boot with a
// guessable secret. Booting is the last moment we can still stop that safely.

const isProd = process.env.NODE_ENV === "production";

/**
 * `next build` evaluates this module with NODE_ENV=production but WITHOUT the
 * runtime environment (the Docker image is built before any secret exists), so
 * the production checks below must not fire during the build phase.
 * SKIP_ENV_VALIDATION is the manual escape hatch (CI, image smoke tests).
 */
const isBuildPhase =
  process.env.NEXT_PHASE === "phase-production-build" || bool(process.env.SKIP_ENV_VALIDATION);

const enforceSecrets = isProd && !isBuildPhase;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  // During `next build` the runtime env is absent by design — don't cry wolf.
  if (isBuildPhase || warned.has(key)) return;
  warned.add(key);
  console.warn(`[config] ${message}`);
}

function fatal(message: string): never {
  throw new Error(`[config] Refusing to start in production: ${message}`);
}

const DEV_AUTH_SECRET = "dev-insecure-secret-change-me";
const MIN_AUTH_SECRET_LENGTH = 32;
const GENERATE_SECRET_HINT = "generate one with `openssl rand -base64 32`";

/** Values that ship in .env.example, docs and old tutorials. */
const PLACEHOLDER_SECRETS = new Set([
  DEV_AUTH_SECRET,
  "change-me-to-a-long-random-string",
  "change-me",
  "changeme",
  "please-change-me",
  "secret",
  "supersecret",
]);

function authSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim() ?? "";

  // AUTH_SECRET signs session cookies AND the e-mail verification links, and
  // verified links auto-sign-in the account they point at
  // (autoSignInAfterVerification) — a known secret means account takeover.
  if (enforceSecrets) {
    if (!secret) fatal(`AUTH_SECRET is not set — ${GENERATE_SECRET_HINT}.`);
    if (PLACEHOLDER_SECRETS.has(secret.toLowerCase()))
      fatal(`AUTH_SECRET is still a placeholder value — ${GENERATE_SECRET_HINT}.`);
    if (secret.length < MIN_AUTH_SECRET_LENGTH)
      fatal(
        `AUTH_SECRET is too short (${secret.length} chars, minimum ${MIN_AUTH_SECRET_LENGTH}) — ${GENERATE_SECRET_HINT}.`,
      );
    return secret;
  }

  if (!secret) {
    warnOnce(
      "auth-secret",
      `AUTH_SECRET is not set — using an insecure development fallback. Set it before deploying (${GENERATE_SECRET_HINT}).`,
    );
    return DEV_AUTH_SECRET;
  }
  return secret;
}

const DEV_DATABASE_URL = "postgresql://modlight:modlight@localhost:5432/modlight";

/** Database passwords that ship as defaults in compose files and examples. */
const PLACEHOLDER_DB_PASSWORDS = new Set([
  "modlight",
  "postgres",
  "password",
  "change-me",
  "changeme",
  "secret",
  "admin",
  "root",
]);

function urlPassword(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim() ?? "";

  if (enforceSecrets) {
    if (!url) fatal("DATABASE_URL is not set.");
    const password = urlPassword(url);
    if (PLACEHOLDER_DB_PASSWORDS.has(password.toLowerCase()))
      fatal(
        "DATABASE_URL still uses the default database password — set POSTGRES_PASSWORD (docker-compose) or a full DATABASE_URL with a generated password.",
      );
    // No password at all is legitimate for unix-socket/peer auth, so only warn.
    if (!password)
      warnOnce("db-password", "DATABASE_URL has no password — make sure the database is not reachable from the network.");
    return url;
  }

  if (!url) {
    warnOnce("db-url", "DATABASE_URL is not set — using the local development database.");
    return DEV_DATABASE_URL;
  }
  return url;
}

// ── Public origins ──────────────────────────────────────────────────────────

/** Strip trailing slashes so every origin concatenates cleanly with a path. */
function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

const APP_URL = normalizeOrigin(process.env.APP_URL?.trim() || "http://localhost:8420");

/**
 * Every hostname this deployment answers on, e.g.
 * APP_DOMAINS="https://host.example.com,https://h.example.com,https://s.example.com".
 *
 * One application, several names: the reverse proxy routes all of them to the
 * same process, so a file uploaded through one name is reachable through every
 * other one. That is the whole reason a user may *pick* which name their links
 * are generated with — switching is cosmetic and can never invalidate a link
 * already in circulation, because the old host keeps resolving.
 *
 * APP_URL is always the first entry (and the fallback), so an install that never
 * sets APP_DOMAINS behaves exactly as it did before.
 */
/**
 * Registrable-ish labels that are never a brand on their own, so
 * `example.co.uk` yields "example" rather than "co".
 */
const SECOND_LEVEL_SUFFIXES = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);

/**
 * The one word a link preview should carry: the site, not the product.
 *
 * Derived from APP_URL (never from the owner's chosen domain), because every
 * hostname of one deployment has to unfurl under the SAME name - otherwise the
 * same file reads as "host.example.com" or "h.example.com" depending on who shared it.
 *   https://host.example.com   -> "example"
 *   https://h.example.com      -> "example"
 *   https://files.example.co.uk -> "example"
 * An IP literal or a single-label host has nothing to strip and is returned whole.
 */
export function brandFromUrl(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* handled below */
  }
  // A bare "host.example.com:8420/path" PARSES (as scheme "host.example.com") rather than
  // throwing, and yields an empty hostname - so fall back on the result too.
  if (!host) {
    host = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0].split(":")[0];
  }
  host = host.replace(/^www\./i, "").replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!host) return "";

  // IPv4/IPv6 literals: no label carries meaning, so don't invent one.
  if (/^\d+(\.\d+)*$/.test(host) || host.includes(":")) return host;

  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 1) return labels[0] ?? "";

  labels.pop(); // TLD
  if (labels.length > 1 && SECOND_LEVEL_SUFFIXES.has(labels[labels.length - 1])) labels.pop();
  return labels[labels.length - 1] ?? "";
}

function appDomains(): readonly string[] {
  const extra = (process.env.APP_DOMAINS ?? "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const origin of [APP_URL, ...extra]) {
    const key = origin.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(origin);
  }
  return Object.freeze(out);
}

export const config = {
  appName: process.env.APP_NAME?.trim() || "Modlight",
  /**
   * Name a link preview signs itself with (og:site_name, oEmbed provider_name).
   *
   * Deliberately NOT appName: the panel, page titles and ShareX configs belong to
   * the product, but a card pasted into a chat belongs to the domain it came
   * from, and saying both means saying the same thing twice. Defaults to the
   * brand inside APP_URL, so a fresh install needs no configuration; set
   * EMBED_BRAND when the domain is not what the site is called.
   *
   * Runtime-only (never reaches next.config headers), so changing it takes a
   * restart, not an image rebuild.
   */
  embedBrand:
    process.env.EMBED_BRAND?.trim() ||
    brandFromUrl(APP_URL) ||
    process.env.APP_NAME?.trim() ||
    "Modlight",
  /** Public base URL, no trailing slash. Used for links, ShareX config, embeds. */
  appUrl: APP_URL,
  /**
   * All origins the app is reachable on, `appUrl` first. A user's
   * `preferredDomain` is only honoured when it appears in this list — the value
   * is echoed into ShareX configs and Open Graph tags, so an unvalidated one
   * would let an account point its own links at a host it doesn't control.
   */
  appDomains: appDomains(),
  /**
   * Base URL used when GENERATING short links. Production points this at a
   * dedicated shortener domain (https://s.example.com) that fronts the very same
   * app, so the distinction is cosmetic: /s/… keeps resolving on APP_URL too
   * and every link already handed out stays valid. Falls back to APP_URL.
   */
  shortUrl: normalizeOrigin(process.env.SHORTLINK_URL?.trim() || APP_URL),
  port: int(process.env.PORT, 8420),
  isProd,
  trustProxy: bool(process.env.TRUST_PROXY, true),

  auth: {
    secret: authSecret(),
    registrationEnabled: bool(process.env.REGISTRATION_ENABLED, false),
  },

  db: {
    url: databaseUrl(),
  },

  storage: {
    driver: (process.env.STORAGE_DRIVER || "local").toLowerCase() as "local" | "s3",
    localPath: process.env.STORAGE_LOCAL_PATH || "./data/storage",
  },

  uploads: {
    /** Max upload size in bytes; 0 = unlimited (large files are the point). */
    maxSize: int(process.env.MAX_UPLOAD_SIZE, 0),
    /**
     * Refuse uploads that would leave the filesystem with less than this free.
     * A full disk does not degrade gracefully: it takes down every database on
     * the host and corrupts any backup caught mid-write. 10 GiB by default.
     */
    minFreeBytes: int(process.env.MIN_FREE_DISK_BYTES, 10 * 1024 * 1024 * 1024),
    /** tus chunk size (bytes) for resumable web uploads. */
    tusChunkSize: int(process.env.TUS_CHUNK_SIZE, 50 * 1024 * 1024),
    /** Where tus keeps in-progress uploads before finalize (local driver). */
    tusTmpPath: process.env.TUS_TMP_PATH || "./data/tus",
    /** Scratch dir for the busboy (ShareX) streaming path. */
    tmpPath: process.env.UPLOAD_TMP_PATH || "./data/tmp",
  },

  /** Default per-user disk quota in bytes; -1 = unlimited. */
  defaultUserQuota: int(process.env.DEFAULT_USER_QUOTA, -1),

  mail: {
    host: process.env.SMTP_HOST || "",
    port: int(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || "",
    password: process.env.SMTP_PASSWORD || "",
    secure: bool(process.env.SMTP_SECURE, false),
    /**
     * "tls" | "starttls" | "none". Empty derives the mode from SMTP_SECURE, the
     * way this has always worked. "starttls" is the one worth choosing
     * deliberately: it REFUSES to continue if the server will not upgrade,
     * where SMTP_SECURE=false merely takes the upgrade if it is offered.
     */
    security: process.env.SMTP_SECURITY || "",
    from: process.env.MAIL_FROM || "no-reply@localhost",
    /**
     * Display name on the From header. Empty falls back to the app name.
     *
     * Separate from `appName` because the two answer different questions: the
     * app name brands the panel, while this is what lands in a stranger's inbox
     * next to the address, and an install is entitled to say "Acme Modlight"
     * there without renaming its own interface.
     */
    fromName: process.env.MAIL_FROM_NAME || "",
    get enabled() {
      return Boolean(process.env.SMTP_HOST);
    },
  },
} as const;

export type AppConfig = typeof config;
