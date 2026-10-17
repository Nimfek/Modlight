import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import en from "@/messages/en/mail.json";
import pl from "@/messages/pl/mail.json";

/**
 * The transactional emails, as data.
 *
 * Two constraints shape everything below, and neither is negotiable because
 * mail clients enforce them:
 *
 *  - **Tables and inline styles only.** Outlook renders HTML with the Word
 *    engine: no flexbox, no grid, no `<style>` rules it feels like ignoring.
 *    Anything that must be right is an attribute or an inline style.
 *  - **Colours as literal hex.** An email has no access to the theme tokens the
 *    app is built on, and compiling CSS variables into a message is a lot of
 *    machinery for six templates. The palette below is therefore a deliberate,
 *    documented COPY of the "modern" skin rather than an import.
 *
 * Translations come from a static import rather than `getTranslations`: mail is
 * sent from Better Auth callbacks and from server actions alike, and the
 * next-intl request config reads cookies, which do not exist for a message sent
 * on somebody else's behalf. A static import also survives the Docker runtime
 * image, which copies `.next` and `public` but not `messages/`.
 */

// ── Palette (copy of the "modern" skin, dark) ───────────────────────────────
const BG = "#0b0b0c";
const CARD = "#151517";
const BORDER = "#26262a";
const TEXT = "#fafafa";
const MUTED = "#a1a1aa";
const FAINT = "#52525b";
const ACCENT = "#6E6BF5";
const WARN = "#f59e0b";

const FONT =
  "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export type MailLocale = "en" | "pl";

const DICTIONARIES: Record<MailLocale, typeof en> = { en, pl: pl as typeof en };

/**
 * Which language to write in.
 *
 * Same rule as the UI (i18n/request.ts): an explicit account preference wins,
 * otherwise a Polish browser gets Polish and everybody else gets English.
 */
export function pickMailLocale(
  preferred?: string | null,
  acceptLanguage?: string | null,
): MailLocale {
  if (preferred === "pl" || preferred === "en") return preferred;
  return /(?:^|[,\s])pl\b/i.test(acceptLanguage ?? "") ? "pl" : "en";
}

/** Look up a dotted key and substitute `{placeholders}`. */
function t(
  locale: MailLocale,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const raw = key
    .split(".")
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], DICTIONARIES[locale]);
  if (typeof raw !== "string") throw new Error(`mail: missing message ${locale}.${key}`);
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** HTML-escape. Every interpolated value goes through this, without exception. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Brand mark
// ---------------------------------------------------------------------------

/** Content-ID of the inline logo. Referenced as `cid:` in the markup. */
export const LOGO_CID = "modlight-logo";

/** Absolute path of the committed PNG (scripts/make-email-logo.ts writes it). */
export function logoPath(): string {
  return path.join(process.cwd(), "public", "brand", "email-logo.png");
}

/**
 * The logo travels as an ATTACHMENT referenced by Content-ID, not as a URL and
 * not as a data URI.
 *
 * A remote URL is blocked by default in most clients until the reader clicks
 * "show images", and `data:` images are stripped outright by Gmail and by
 * Outlook desktop. CID is the one form that renders in Gmail, Outlook, Apple
 * Mail and Thunderbird without asking permission.
 */
export function logoAttachment(): { filename: string; path: string; cid: string } {
  return { filename: "logo.png", path: logoPath(), cid: LOGO_CID };
}

/** Cached because the file is baked into the image and cannot appear later. */
let logoPresent: boolean | null = null;

/**
 * The logo attachment, or nothing at all.
 *
 * Nodemailer reads a `path` attachment from disk as it streams the message, so
 * a missing file does not produce a message without a picture — it throws
 * ENOENT and the send fails. Attached unconditionally, one absent PNG would
 * therefore take out password resets, confirmations and invitations together,
 * with an error naming a file nobody would connect to "I never got the email".
 *
 * Degrading to a logo-less message costs a 40px image and the reader still sees
 * the alt text. That is the right trade against silently losing every
 * transactional mail on the install.
 */
export function logoAttachments(): Array<{ filename: string; path: string; cid: string }> {
  if (logoPresent === null) {
    logoPresent = existsSync(logoPath());
    if (!logoPresent) {
      console.warn(`[mail] brand logo missing at ${logoPath()} — sending without it`);
    }
  }
  return logoPresent ? [logoAttachment()] : [];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface LayoutParts {
  locale: MailLocale;
  preheader: string;
  title: string;
  /** Already-escaped HTML for the body column. */
  bodyHtml: string;
}

function layout(parts: LayoutParts): string {
  const appName = esc(config.appName);
  return `<!doctype html>
<html lang="${parts.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- Declared dark-only, and honestly so: every colour below is a hardcoded dark
     hex. Claiming to support both schemes invites a dark-mode client to apply
     its own inversion on top of ours, which is how a message ends up with dark
     text on a dark card. -->
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(parts.title)}</title>
</head>
<body style="margin:0;padding:0;background:${BG};font-family:${FONT}">
<!-- Preheader: the line a mailbox shows next to the subject. Without one, the
     preview is the first sentence of the body, which is usually the disclaimer. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(parts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};padding:32px 12px">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${CARD};border:1px solid ${BORDER};border-radius:16px">
        <tr>
          <td style="padding:28px 32px 4px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-right:10px" valign="middle">
                  <img src="cid:${LOGO_CID}" width="40" height="40" alt="${esc(t(parts.locale, "common.logoAlt", { appName: config.appName }))}" style="display:block;border:0;border-radius:9px">
                </td>
                <td valign="middle" style="font-family:${FONT};font-size:17px;font-weight:700;color:${TEXT}">${appName}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 0;font-family:${FONT};font-size:21px;line-height:1.3;font-weight:600;color:${TEXT}">${esc(parts.title)}</td>
        </tr>
        <tr>
          <td style="padding:12px 32px 32px;font-family:${FONT};font-size:14px;line-height:1.65;color:${MUTED}">${parts.bodyHtml}</td>
        </tr>
      </table>
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
        <tr>
          <td style="padding:16px 32px;font-family:${FONT};font-size:12px;line-height:1.6;color:${FAINT}">
            ${esc(t(parts.locale, "common.footer", { appName: config.appName }))}<br>
            ${esc(t(parts.locale, "common.automated"))}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function paragraph(text: string, color = MUTED): string {
  return `<p style="margin:0 0 14px;color:${color};font-size:14px;line-height:1.65">${esc(text)}</p>`;
}

/**
 * A call to action, followed by the same URL in plain text.
 *
 * The visible URL is not redundant: clients that strip links, text-mode
 * readers and anybody forwarding the message to a colleague all need the
 * address itself, and a button whose target cannot be seen is exactly the
 * shape of a phishing mail.
 */
function action(url: string, label: string, fallbackLabel: string): string {
  const safe = esc(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 14px">
  <tr><td align="center" bgcolor="${ACCENT}" style="border-radius:10px">
    <a href="${safe}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${esc(label)}</a>
  </td></tr>
</table>
<p style="margin:0 0 6px;color:${FAINT};font-size:12px">${esc(fallbackLabel)}</p>
<p style="margin:0 0 14px;font-size:12px;word-break:break-all"><a href="${safe}" style="color:${ACCENT};text-decoration:underline">${safe}</a></p>`;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

function build(
  locale: MailLocale,
  ns: string,
  vars: Record<string, string | number>,
  body: { html: string; text: string },
): RenderedMail {
  const withApp = { appName: config.appName, ...vars };
  return {
    subject: t(locale, `${ns}.subject`, withApp),
    html: layout({
      locale,
      preheader: t(locale, `${ns}.preheader`, withApp),
      title: t(locale, `${ns}.title`, withApp),
      bodyHtml: body.html,
    }),
    text: body.text,
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

interface LinkMail {
  locale: MailLocale;
  email: string;
  url: string;
}

function linkTemplate(ns: string, { locale, email, url }: LinkMail): RenderedMail {
  const vars = { appName: config.appName, email };
  const intro = t(locale, `${ns}.intro`, vars);
  const expiry = t(locale, `${ns}.expiry`, vars);
  const ignore = t(locale, `${ns}.ignore`, vars);
  const label = t(locale, `${ns}.button`, vars);
  const fallback = t(locale, "common.linkFallback");

  return build(locale, ns, vars, {
    html:
      paragraph(intro) +
      action(url, label, fallback) +
      paragraph(expiry, FAINT) +
      paragraph(ignore, FAINT),
    text: [intro, "", `${label}: ${url}`, "", expiry, ignore].join("\n"),
  });
}

export function renderVerifyEmail(input: LinkMail): RenderedMail {
  return linkTemplate("verifyEmail", input);
}

export function renderResetPassword(input: LinkMail): RenderedMail {
  return linkTemplate("resetPassword", input);
}

export function renderAccountInvited(input: LinkMail): RenderedMail {
  return linkTemplate("accountInvited", input);
}

export function renderSmtpTest(input: {
  locale: MailLocale;
  host: string;
  port: number;
  from: string;
}): RenderedMail {
  const vars = {
    appName: config.appName,
    host: input.host,
    port: input.port,
    from: input.from,
  };
  const intro = t(input.locale, "smtpTest.intro", vars);
  const detail = t(input.locale, "smtpTest.detail", vars);
  const closing = t(input.locale, "smtpTest.closing", vars);

  return build(input.locale, "smtpTest", vars, {
    html: paragraph(intro) + paragraph(detail, TEXT) + paragraph(closing, FAINT),
    text: [intro, "", detail, "", closing].join("\n"),
  });
}

export function renderPasswordChanged(input: {
  locale: MailLocale;
  email: string;
}): RenderedMail {
  const vars = { appName: config.appName, email: input.email };
  const intro = t(input.locale, "passwordChanged.intro", vars);
  const closing = t(input.locale, "passwordChanged.closing", vars);
  const warning = t(input.locale, "passwordChanged.warning", vars);

  return build(input.locale, "passwordChanged", vars, {
    html: paragraph(intro) + paragraph(closing) + paragraph(warning, WARN),
    text: [intro, "", closing, warning].join("\n"),
  });
}

export function renderEmailChanged(input: {
  locale: MailLocale;
  oldEmail: string;
  newEmail: string;
}): RenderedMail {
  const vars = {
    appName: config.appName,
    oldEmail: input.oldEmail,
    newEmail: input.newEmail,
  };
  const intro = t(input.locale, "emailChanged.intro", vars);
  const closing = t(input.locale, "emailChanged.closing", vars);
  const warning = t(input.locale, "emailChanged.warning", vars);

  return build(input.locale, "emailChanged", vars, {
    html: paragraph(intro) + paragraph(closing) + paragraph(warning, WARN),
    text: [intro, "", closing, warning].join("\n"),
  });
}
