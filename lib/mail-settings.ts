import { createHash } from "node:crypto";
import { config } from "@/lib/config";
import {
  getSettings,
  isOn,
  setSetting,
  type SettingKey,
} from "@/lib/settings";
import { encryptSecret, tryDecryptSecret } from "@/lib/secret-box";

/**
 * Where the mail configuration comes from, and what it currently is.
 *
 * The one non-obvious rule here is BLOCK PRECEDENCE: either the whole SMTP
 * configuration comes from the panel, or the whole of it comes from the
 * environment. Never a field from each.
 *
 * That is a security rule, not a tidiness one. Merged per-field, an
 * administrator who changes only the host in the panel would inherit
 * `SMTP_USER` and `SMTP_PASSWORD` from .env, and the application would then
 * send those credentials to a server the administrator just named. Block
 * precedence makes that impossible to express.
 *
 * The panel wins over the environment because a "Save" button that changes
 * nothing is a lie, and because the rest of the app already works this way
 * (`isRegistrationEnabled`: row first, env as the seed).
 */

export type SmtpSecurity = "none" | "starttls" | "tls";
export type MailSource = "panel" | "env" | "none";
export type MailPasswordState = "unset" | "set" | "undecryptable";

export const SMTP_SETTING_KEYS = [
  "smtp_host",
  "smtp_port",
  "smtp_security",
  "smtp_user",
  "smtp_password_enc",
  "mail_from",
  "mail_from_name",
  "email_verification_required",
] as const satisfies readonly SettingKey[];

export interface EnvMail {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
  /** Explicit mode from SMTP_SECURITY; null = derive it from `secure`. */
  security: SmtpSecurity | null;
  from: string;
  fromName: string;
}

export interface ResolvedMail {
  source: MailSource;
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  /** Never leaves the server. Not part of anything returned to a client. */
  password: string;
  from: string;
  fromName: string;
  /** Enough configuration to attempt a send. */
  ready: boolean;
  passwordState: MailPasswordState;
  /** Must a new account confirm its address before it can sign in? */
  verificationRequired: boolean;
}

/** What a browser is allowed to learn about the mail configuration. */
export interface MailStatus {
  source: MailSource;
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  from: string;
  fromName: string;
  ready: boolean;
  passwordState: MailPasswordState;
  verificationRequired: boolean;
  /** True when SMTP_* is present in the environment (for the panel's badge). */
  envAvailable: boolean;
}

function toSecurity(value: string | undefined): SmtpSecurity {
  return value === "tls" || value === "starttls" || value === "none" ? value : "starttls";
}

function toPort(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 65536 ? Math.trunc(n) : fallback;
}

/**
 * Resolve the effective configuration. Pure: every input is a parameter,
 * including the decryption step, so the precedence rule can be unit-tested
 * without a database or a key.
 */
export function resolveMailSettings(
  rows: Partial<Record<SettingKey, string>>,
  env: EnvMail,
  decrypt: (box: string) => string | null,
): ResolvedMail {
  const verificationRequired = isOn(rows.email_verification_required);
  const panelHost = rows.smtp_host?.trim() ?? "";

  if (panelHost) {
    const box = rows.smtp_password_enc ?? "";
    const decrypted = box ? decrypt(box) : "";
    const passwordState: MailPasswordState = !box
      ? "unset"
      : decrypted === null
        ? "undecryptable"
        : "set";

    const user = rows.smtp_user?.trim() ?? "";
    // A password that cannot be read is NOT the same as no password: sending
    // an empty string to a server that expects credentials produces an
    // unexplainable authentication loop, so the block counts as unusable.
    const usable = passwordState !== "undecryptable" && (!user || passwordState === "set");

    return {
      source: "panel",
      host: panelHost,
      port: toPort(rows.smtp_port, 587),
      security: toSecurity(rows.smtp_security),
      user,
      password: decrypted ?? "",
      from: rows.mail_from?.trim() || env.from,
      fromName: rows.mail_from_name?.trim() || config.appName,
      ready: usable,
      passwordState,
      verificationRequired: verificationRequired && usable,
    };
  }

  if (env.host.trim()) {
    return {
      source: "env",
      host: env.host.trim(),
      port: env.port,
      // SMTP_SECURITY, when given, says exactly which of the three modes to use.
      // Worth having as its own variable because the old boolean cannot express
      // the one a new install on port 587 actually wants: "starttls" REQUIRES
      // the upgrade, whereas the boolean's false branch merely hopes for it, and
      // a stripped STARTTLS puts the password on the wire in clear.
      //
      // Unset keeps the historical mapping exactly, so an install that works
      // today keeps working: SMTP_SECURE=true is implicit TLS (465), false is a
      // plain connect with nodemailer's opportunistic upgrade.
      security: env.security ?? (env.secure ? "tls" : "none"),
      user: env.user,
      password: env.password,
      from: env.from,
      fromName: env.fromName || config.appName,
      ready: true,
      passwordState: env.password ? "set" : "unset",
      verificationRequired,
    };
  }

  return {
    source: "none",
    host: "",
    port: 587,
    security: "starttls",
    user: "",
    password: "",
    from: env.from,
    fromName: config.appName,
    ready: false,
    passwordState: "unset",
    // Requiring a confirmation nobody can be sent locks every new account out.
    verificationRequired: false,
  };
}

/** Redact a resolved configuration down to what a browser may see. */
export function toMailStatus(resolved: ResolvedMail): MailStatus {
  return {
    source: resolved.source,
    host: resolved.host,
    port: resolved.port,
    security: resolved.security,
    user: resolved.user,
    from: resolved.from,
    fromName: resolved.fromName,
    ready: resolved.ready,
    passwordState: resolved.passwordState,
    verificationRequired: resolved.verificationRequired,
    envAvailable: Boolean(envMail().host.trim()),
  };
}

/**
 * Identity of a configuration, for cache invalidation.
 *
 * The password takes part as a HASH, never as itself: fingerprints end up in
 * debug output, and one that carries a credential is a credential in a log.
 */
export function mailFingerprint(resolved: ResolvedMail): string {
  const passwordMark = resolved.password
    ? createHash("sha256").update(resolved.password).digest("hex").slice(0, 16)
    : "-";
  return [
    resolved.source,
    resolved.host,
    resolved.port,
    resolved.security,
    resolved.user,
    resolved.from,
    passwordMark,
  ].join("|");
}

export function envMail(): EnvMail {
  return {
    host: config.mail.host,
    port: config.mail.port,
    user: config.mail.user,
    password: config.mail.password,
    secure: config.mail.secure,
    security: ((): SmtpSecurity | null => {
      const raw = config.mail.security.trim().toLowerCase();
      return raw === "tls" || raw === "starttls" || raw === "none" ? raw : null;
    })(),
    from: config.mail.from,
    fromName: config.mail.fromName,
  };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

interface Snapshot {
  value: ResolvedMail;
  readAt: number;
}

/** How long a snapshot is trusted before the table is consulted again. */
const TTL_MS = 30_000;

// Survives HMR in dev, and is per-process by design: a second container would
// simply re-read within the TTL.
const store = ((globalThis as unknown as { __mlMailSnapshot?: { current?: Snapshot } }).__mlMailSnapshot ??=
  {});

function decryptSmtpPassword(box: string): string | null {
  const res = tryDecryptSecret(box, "smtp");
  return res.ok ? res.value : null;
}

/** Read the effective configuration, refreshing the snapshot when it is stale. */
export async function loadMailSettings(force = false): Promise<ResolvedMail> {
  const cached = store.current;
  if (!force && cached && Date.now() - cached.readAt < TTL_MS) return cached.value;

  const rows = await getSettings(SMTP_SETTING_KEYS);
  const value = resolveMailSettings(rows, envMail(), decryptSmtpPassword);
  store.current = { value, readAt: Date.now() };
  return value;
}

/**
 * The last known configuration, WITHOUT awaiting.
 *
 * This exists for exactly one caller: `emailAndPassword.requireEmailVerification`
 * in lib/auth.ts. Better Auth reads that option on every request, so a getter is
 * what makes a panel change take effect without a restart — but a getter cannot
 * await, hence a snapshot instead of a query.
 *
 * Before the first load it falls back to the environment, which is the same
 * answer the old build-time constant gave.
 */
export function mailSnapshot(): ResolvedMail {
  return (
    store.current?.value ?? resolveMailSettings({}, envMail(), decryptSmtpPassword)
  );
}

export function mailReadySync(): boolean {
  return mailSnapshot().ready;
}

export function verificationRequiredSync(): boolean {
  const snap = mailSnapshot();
  // Belt and braces: `resolveMailSettings` already refuses to require what it
  // cannot send, but this is the value that decides whether people can sign in.
  return snap.verificationRequired && snap.ready;
}

export async function mailReady(): Promise<boolean> {
  return (await loadMailSettings()).ready;
}

/** Drop the snapshot so the next read hits the table. Call after every write. */
export function invalidateMailSettings(): void {
  store.current = undefined;
}

/** Populate the snapshot at boot so the first request is not answered from env. */
export async function warmMailSettings(): Promise<void> {
  try {
    await loadMailSettings(true);
  } catch (err) {
    // A database that is not up yet must not stop the server from starting;
    // the next read will refresh the snapshot anyway.
    console.warn("[mail] could not preload settings:", err);
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface MailSettingsPatch {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  /**
   * Empty/undefined means "leave the stored password alone".
   *
   * A blank field in a form is how a browser renders "we are not showing you
   * this", so treating it as "clear the password" would wipe the credential
   * every time somebody changed the port. Clearing is a separate, explicit act.
   */
  password?: string;
  from: string;
  fromName: string;
}

/**
 * Write the SMTP block. Deliberately does NOT touch
 * `email_verification_required`.
 *
 * That flag used to ride along on this patch, and it was the same defect that
 * once shipped on `register_enabled`: the value the form sends back is the
 * EFFECTIVE one, and `resolveMailSettings` masks it to false whenever the block
 * cannot currently send (`verificationRequired && usable`). So the very first
 * save of a new SMTP configuration — user typed, password not yet stored, block
 * therefore not usable — read the masked false and wrote "off" over an
 * administrator's "on", permanently and with no message. A setting must only
 * ever be written from the value that was actually stored, or by an action
 * whose entire purpose is to change it (`setEmailVerificationRequired`).
 */
export async function saveMailSettings(
  patch: MailSettingsPatch,
): Promise<{ changed: string[]; passwordChanged: boolean }> {
  const before = await getSettings(SMTP_SETTING_KEYS);
  const changed: string[] = [];

  const writes: [SettingKey, string | null][] = [
    ["smtp_host", patch.host.trim()],
    ["smtp_port", String(toPort(String(patch.port), 587))],
    ["smtp_security", toSecurity(patch.security)],
    ["smtp_user", patch.user.trim()],
    ["mail_from", patch.from.trim()],
    ["mail_from_name", patch.fromName.trim()],
  ];

  for (const [key, value] of writes) {
    if ((before[key] ?? "") !== (value ?? "")) changed.push(key);
    await setSetting(key, value);
  }

  const passwordChanged = Boolean(patch.password && patch.password.length > 0);
  if (passwordChanged) {
    await setSetting("smtp_password_enc", encryptSecret(patch.password!, "smtp"));
  } else if (
    (before.smtp_host ?? "") !== patch.host.trim() ||
    (before.smtp_user ?? "") !== patch.user.trim()
  ) {
    // The stored password was issued BY a particular server TO a particular
    // account. Point the block at a different host or a different user and
    // keeping it means the next send hands that credential to somebody who was
    // never meant to have it — which is precisely the leak that block
    // precedence prevents between the panel and the environment, reappearing
    // inside the panel block.
    //
    // "Blank means keep the stored one" therefore holds only while the identity
    // it belongs to is unchanged. Changing the identity forgets it, the card
    // reports `passwordState: "unset"`, and mail stays off until a real
    // password is typed. (The action layer refuses to save a user name with no
    // password at all, so this is a state an operator is told about, not one
    // they can wander into.)
    await setSetting("smtp_password_enc", null);
    changed.push("smtp_password_enc");
  }

  invalidateMailSettings();
  return { changed, passwordChanged };
}

/** Remove every panel row, handing the configuration back to the environment. */
export async function clearMailSettings(): Promise<void> {
  for (const key of SMTP_SETTING_KEYS) {
    if (key === "email_verification_required") continue; // not part of the SMTP block
    await setSetting(key, null);
  }
  invalidateMailSettings();
}

/** Forget only the stored password, keeping the rest of the block. */
export async function clearMailPassword(): Promise<void> {
  await setSetting("smtp_password_enc", null);
  invalidateMailSettings();
}

/** Turn address confirmation on or off without touching the SMTP block. */
export async function setEmailVerificationRequired(required: boolean): Promise<void> {
  await setSetting("email_verification_required", required ? "on" : "off");
  invalidateMailSettings();
}
