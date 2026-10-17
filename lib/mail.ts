import nodemailer, { type Transporter } from "nodemailer";
import {
  loadMailSettings,
  mailFingerprint,
  type ResolvedMail,
} from "@/lib/mail-settings";
import { logoAttachments } from "@/lib/mail-templates";
import { redactSecrets, smtpSecretForms } from "@/lib/secret-box";
import { config } from "@/lib/config";

/**
 * Outgoing mail: the transport, and nothing else. What the messages SAY lives
 * in lib/mail-templates.ts; where the credentials come from lives in
 * lib/mail-settings.ts.
 */

export class MailNotConfiguredError extends Error {
  constructor() {
    super("Outgoing mail is not configured on this installation.");
    this.name = "MailNotConfiguredError";
  }
}

/**
 * Connection timeouts.
 *
 * nodemailer sets none of these by default, which is fine for a background job
 * and wrong for the "send a test message" button: a wrong host or a firewalled
 * port would leave the operator staring at a spinner until the kernel gave up
 * on the TCP handshake, which can take minutes.
 */
const TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
  // nodemailer's debug output prints the AUTH exchange to stdout. Never on.
  logger: false as const,
  debug: false as const,
};

interface Cached {
  fingerprint: string;
  transport: Transporter;
}

const store = ((globalThis as unknown as { __mlMailTransport?: { current?: Cached } })
  .__mlMailTransport ??= {});

function transportOptions(mail: ResolvedMail) {
  return {
    host: mail.host,
    port: mail.port,
    // "tls" is implicit TLS (the historical port 465). "starttls" connects in
    // clear and REFUSES to continue if the server will not upgrade. "none"
    // leaves nodemailer's opportunistic upgrade in charge, which is what an
    // env-configured install has always done.
    secure: mail.security === "tls",
    requireTLS: mail.security === "starttls",
    auth: mail.user ? { user: mail.user, pass: mail.password } : undefined,
    ...TIMEOUTS,
  };
}

/**
 * The transporter for the CURRENT configuration.
 *
 * Cached against a fingerprint of the settings it was built from rather than
 * cleared by hand after a save. A manual `invalidate()` only ever reaches the
 * process that performed the write; a fingerprint recomputed from what was just
 * read invalidates the cache in every process that reads the new value, which
 * is what makes a second container behave.
 */
export async function getTransport(): Promise<{ transport: Transporter; mail: ResolvedMail } | null> {
  const mail = await loadMailSettings();
  if (!mail.ready) return null;

  const fingerprint = mailFingerprint(mail);
  if (store.current?.fingerprint !== fingerprint) {
    // Close the old connection pool: leaving it open would keep authenticating
    // against the server the operator just stopped using.
    store.current?.transport.close();
    store.current = { fingerprint, transport: nodemailer.createTransport(transportOptions(mail)) };
  }
  return { transport: store.current.transport, mail };
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * The From header. The display name is stripped of quotes rather than escaped:
 * a name is not worth a header-injection surface, and nobody's brand needs one.
 */
export function envelopeFrom(mail: ResolvedMail): string {
  const name = mail.fromName.replace(/["\r\n]/g, "").trim();
  return name ? `"${name}" <${mail.from}>` : mail.from;
}

/**
 * Send one message.
 *
 * Refuses loudly when mail is not configured, and that is a deliberate change:
 * the previous behaviour logged the message to the console and reported
 * success, so "reset my password" told the user to check an inbox that would
 * never receive anything. A caller that must not fail (verification on sign-up)
 * checks `mailReady()` first rather than relying on a silent no-op.
 *
 * Development keeps the console fallback, because a developer with no SMTP
 * server still has to be able to click the link.
 */
export async function sendMail(msg: MailMessage): Promise<void> {
  const t = await getTransport();
  if (!t) {
    if (!config.isProd) {
      console.log(`[mail:dev] To: ${msg.to} | ${msg.subject}\n${msg.text ?? msg.html}`);
      return;
    }
    throw new MailNotConfiguredError();
  }

  try {
    await t.transport.sendMail({
      from: envelopeFrom(t.mail),
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: logoAttachments(),
    });
  } catch (err) {
    // The server's own error text routinely quotes part of the AUTH line back
    // at us, so nothing from this exception may reach a log untouched.
    throw new Error(redactMailError(err, t.mail));
  }
}

/** Strip credentials out of an SMTP error before anyone can read it. */
function redactMailError(err: unknown, mail: ResolvedMail): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw, smtpSecretForms(mail.user, mail.password));
}
