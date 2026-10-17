"use server";

/**
 * Administration of outgoing mail.
 *
 * Three rules run through every function here:
 *
 *  1. **The SMTP password never travels back.** Not to the browser, not into an
 *     audit entry, not into a log line. The panel learns a STATE
 *     ("set" / "unset" / "undecryptable") and nothing else.
 *  2. **Failures travel as data, not as thrown messages.** Next masks the
 *     message of an error raised inside a Server Action in production, so an
 *     operator debugging SMTP would receive "An error occurred" instead of the
 *     server's own explanation.
 *  3. **Every write is audited**, by field name. Which knob was turned is
 *     operationally useful; what it was turned to is, in one case, a credential.
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireAdmin } from "@/lib/auth-helpers";
import { recordAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/password";
import { redactSecrets, smtpSecretForms } from "@/lib/secret-box";
import { envelopeFrom, getTransport } from "@/lib/mail";
import {
  clearMailPassword,
  clearMailSettings,
  invalidateMailSettings,
  loadMailSettings,
  saveMailSettings,
  setEmailVerificationRequired,
  toMailStatus,
  type MailSettingsPatch,
  type MailStatus,
  type SmtpSecurity,
} from "@/lib/mail-settings";
import { logoAttachments, pickMailLocale, renderSmtpTest } from "@/lib/mail-templates";

/** What the panel is allowed to know. Never contains a credential. */
export async function loadMailStatus(): Promise<MailStatus> {
  await requireAdmin();
  return toMailStatus(await loadMailSettings(true));
}

export interface SaveMailInput {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  /** Blank means "keep the stored password". Clearing is a separate action. */
  password?: string;
  from: string;
  fromName: string;
}

export type SaveMailResult =
  | { ok: true; status: MailStatus; changed: string[] }
  | {
      ok: false;
      reason: "invalid-host" | "invalid-from" | "invalid-port" | "password-required";
    };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Hostname or IP literal. Deliberately permissive: internal names are valid. */
const HOST_PATTERN = /^[a-z0-9._:-]+$/i;

export async function saveSmtpSettings(input: SaveMailInput): Promise<SaveMailResult> {
  const session = await requireAdmin();

  const host = input.host.trim();
  const from = input.from.trim();
  if (!host || !HOST_PATTERN.test(host)) return { ok: false, reason: "invalid-host" };
  if (!from || !EMAIL_PATTERN.test(from)) return { ok: false, reason: "invalid-from" };
  if (!Number.isFinite(input.port) || input.port < 1 || input.port > 65535) {
    return { ok: false, reason: "invalid-port" };
  }

  // A user name with no password anywhere is a block that can never send, and
  // saving one is how "configure here" on an environment-backed install used to
  // silently kill working mail: the form seeds the host and the user from the
  // environment but NEVER the password (it is write-only), so an operator who
  // clicks straight through arrives at panel rows with a user and no
  // credential. Refusing here keeps the environment configuration in charge
  // until a real password has been typed.
  const current = await loadMailSettings(true);
  // The stored password survives a save only while it still belongs to the same
  // server and account — `saveMailSettings` drops it when either changes, so
  // "there is one stored" is not on its own a reason to believe there will be
  // one afterwards.
  const identityUnchanged =
    current.source === "panel" &&
    current.host === host &&
    current.user === input.user.trim();
  const willHavePassword =
    Boolean(input.password) || (identityUnchanged && current.passwordState === "set");
  if (input.user.trim() && !willHavePassword) return { ok: false, reason: "password-required" };

  const patch: MailSettingsPatch = {
    host,
    port: Math.trunc(input.port),
    security: input.security,
    user: input.user,
    password: input.password,
    from,
    fromName: input.fromName,
  };

  const { changed, passwordChanged } = await saveMailSettings(patch);

  await recordAudit(session.user.id, "mail.settings_changed", {
    by: session.user.id,
    byEmail: session.user.email,
    // Names only. The values include a credential.
    changed,
    passwordChanged,
  });

  revalidatePath("/dashboard/admin");
  return { ok: true, status: toMailStatus(await loadMailSettings(true)), changed };
}

/** Hand the configuration back to the environment by deleting the panel rows. */
export async function clearSmtpSettings(): Promise<MailStatus> {
  const session = await requireAdmin();
  await clearMailSettings();
  await recordAudit(session.user.id, "mail.settings_cleared", {
    by: session.user.id,
    byEmail: session.user.email,
  });
  revalidatePath("/dashboard/admin");
  return toMailStatus(await loadMailSettings(true));
}

/** Forget the stored password, keeping the rest of the configuration. */
export async function clearSmtpPassword(): Promise<MailStatus> {
  const session = await requireAdmin();
  await clearMailPassword();
  await recordAudit(session.user.id, "mail.password_cleared", {
    by: session.user.id,
    byEmail: session.user.email,
  });
  revalidatePath("/dashboard/admin");
  return toMailStatus(await loadMailSettings(true));
}

/** Turn address confirmation on or off without touching the SMTP block. */
export async function setVerificationRequired(required: boolean): Promise<MailStatus> {
  const session = await requireAdmin();
  await setEmailVerificationRequired(required);
  await recordAudit(session.user.id, "mail.verification_toggled", {
    by: session.user.id,
    byEmail: session.user.email,
    required,
  });
  revalidatePath("/dashboard/admin");
  return toMailStatus(await loadMailSettings(true));
}

// ---------------------------------------------------------------------------
// The test button
// ---------------------------------------------------------------------------

export type MailTestFailure =
  | "not-configured"
  | "rate-limited"
  | "auth"
  | "connection"
  | "tls"
  | "recipient"
  | "unknown";

export type MailTestResult =
  | { ok: true; accepted: string[]; tookMs: number }
  | { ok: false; kind: MailTestFailure; smtpCode?: number; serverSays?: string; tookMs: number };

/** Map nodemailer's error vocabulary onto something an operator can act on. */
function classify(err: unknown): { kind: MailTestFailure; smtpCode?: number } {
  const e = err as { code?: string; responseCode?: number; command?: string };
  const code = e?.code ?? "";
  const smtpCode = typeof e?.responseCode === "number" ? e.responseCode : undefined;

  if (code === "EAUTH" || smtpCode === 535 || smtpCode === 534) return { kind: "auth", smtpCode };
  if (code === "EENVELOPE" || smtpCode === 550 || smtpCode === 553 || smtpCode === 554) {
    return { kind: "recipient", smtpCode };
  }
  if (code === "ETLS" || code === "ESOCKET") return { kind: "tls", smtpCode };
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "EDNS") {
    return { kind: "connection", smtpCode };
  }
  return { kind: "unknown", smtpCode };
}

/**
 * Send a real message rather than calling `transporter.verify()`.
 *
 * `verify()` proves the connection and the credentials, and stops exactly one
 * step before the thing that most often goes wrong: whether the server will
 * accept an envelope from the configured From address. "Relay access denied"
 * and "sender address rejected" are invisible to `verify()` and fatal in
 * practice, so the test has to put a message on the wire.
 */
export async function sendTestMail(to?: string): Promise<MailTestResult> {
  const session = await requireAdmin();
  const started = Date.now();

  // This button opens an outbound connection to whatever host:port the panel
  // currently names, so it is a small port scanner if left unthrottled.
  const gate = checkRateLimit(`mail-test:${session.user.id}`, 5, 15 * 60_000);
  if (!gate.allowed) return { ok: false, kind: "rate-limited", tookMs: 0 };

  // Read through, never from the snapshot: the operator has just pressed Save.
  invalidateMailSettings();
  const t = await getTransport();
  if (!t) return { ok: false, kind: "not-configured", tookMs: Date.now() - started };

  const recipient = (to ?? "").trim() || session.user.email;
  const locale = pickMailLocale(
    (session.user as { locale?: string | null }).locale ?? null,
    (await headers()).get("accept-language"),
  );
  const message = renderSmtpTest({
    locale,
    host: t.mail.host,
    port: t.mail.port,
    from: t.mail.from,
  });

  const secrets = smtpSecretForms(t.mail.user, t.mail.password);

  try {
    // Deliberately not `sendMail()`: this path needs the transport's own error
    // object to classify the failure, and `sendMail` converts it to a string.
    const info = await t.transport.sendMail({
      from: envelopeFrom(t.mail),
      to: recipient,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: logoAttachments(),
    });
    const tookMs = Date.now() - started;

    await recordAudit(session.user.id, "mail.test_sent", {
      by: session.user.id,
      byEmail: session.user.email,
      to: recipient,
      ok: true,
    });

    return { ok: true, accepted: (info.accepted ?? []).map(String), tookMs };
  } catch (err) {
    const { kind, smtpCode } = classify(err);
    const tookMs = Date.now() - started;

    // The server's own words are the whole diagnostic value of this button
    // ("535 5.7.8 Username and Password not accepted" answers the question on
    // its own), but they are also where an echoed AUTH line would appear.
    const rawResponse = (err as { response?: string })?.response;
    const serverSays = rawResponse
      ? redactSecrets(String(rawResponse), secrets).slice(0, 400)
      : redactSecrets(err instanceof Error ? err.message : String(err), secrets).slice(0, 400);

    await recordAudit(session.user.id, "mail.test_sent", {
      by: session.user.id,
      byEmail: session.user.email,
      to: recipient,
      ok: false,
      kind,
      smtpCode,
    });

    return { ok: false, kind, smtpCode, serverSays, tookMs };
  }
}
