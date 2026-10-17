import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import {
  logoPath,
  pickMailLocale,
  renderAccountInvited,
  renderEmailChanged,
  renderPasswordChanged,
  renderResetPassword,
  renderSmtpTest,
  renderVerifyEmail,
  type MailLocale,
  type RenderedMail,
} from "@/lib/mail-templates";

const LOCALES: MailLocale[] = ["en", "pl"];
const URL = "https://files.example.invalid/verify/abc123";

function every(locale: MailLocale): { name: string; mail: RenderedMail }[] {
  return [
    { name: "verifyEmail", mail: renderVerifyEmail({ locale, email: "ada@example.invalid", url: URL }) },
    { name: "resetPassword", mail: renderResetPassword({ locale, email: "ada@example.invalid", url: URL }) },
    { name: "accountInvited", mail: renderAccountInvited({ locale, email: "ada@example.invalid", url: URL }) },
    { name: "smtpTest", mail: renderSmtpTest({ locale, host: "smtp.example.invalid", port: 587, from: "no-reply@example.invalid" }) },
    { name: "passwordChanged", mail: renderPasswordChanged({ locale, email: "ada@example.invalid" }) },
    { name: "emailChanged", mail: renderEmailChanged({ locale, oldEmail: "old@example.invalid", newEmail: "new@example.invalid" }) },
  ];
}

describe("transactional emails", () => {
  for (const locale of LOCALES) {
    for (const { name, mail } of every(locale)) {
      describe(`${name} (${locale})`, () => {
        it("has a subject, an HTML body and a plain-text body", () => {
          expect(mail.subject.trim()).not.toBe("");
          expect(mail.html).toContain("<html");
          expect(mail.text.trim()).not.toBe("");
        });

        it("leaves no placeholder unsubstituted", () => {
          expect(mail.subject).not.toMatch(/\{\w+\}/);
          expect(mail.text).not.toMatch(/\{\w+\}/);
        });

        it("uses plain hyphens in what the reader sees", () => {
          expect(mail.subject + mail.text).not.toContain("—");
          expect(mail.subject + mail.text).not.toContain("–");
        });

        it("lays out with tables, which is what Outlook can render", () => {
          expect(mail.html).toContain('role="presentation"');
          expect(mail.html).not.toContain("display:flex");
          expect(mail.html).not.toContain("display:grid");
        });

        it("carries the brand mark by content id, not as a remote image", () => {
          expect(mail.html).toContain("cid:modlight-logo");
          expect(mail.html).not.toContain("src=\"data:");
        });
      });
    }
  }

  for (const locale of LOCALES) {
    it(`shows the full link as text, not only as a button (${locale})`, () => {
      // Clients that strip links, text-mode readers and anybody forwarding the
      // message all need the address itself.
      for (const name of ["verifyEmail", "resetPassword", "accountInvited"]) {
        const mail = every(locale).find((m) => m.name === name)!.mail;
        expect(mail.html, name).toContain(URL);
        expect(mail.text, name).toContain(URL);
      }
    });
  }

  it("escapes interpolated values instead of pasting them into markup", () => {
    const mail = renderVerifyEmail({
      locale: "en",
      email: '"><script>alert(1)</script>',
      url: "https://example.invalid/?a=1&b=2",
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&amp;b=2");
  });

  it("says the same things in both languages", () => {
    const en = every("en").map((m) => m.name);
    const pl = every("pl").map((m) => m.name);
    expect(pl).toEqual(en);
    for (const name of en) {
      const a = every("en").find((m) => m.name === name)!.mail;
      const b = every("pl").find((m) => m.name === name)!.mail;
      expect(b.subject, name).not.toBe(a.subject); // actually translated
    }
  });

  it("ships the raster logo the messages reference", () => {
    // A missing file would make nodemailer throw on every send, at runtime.
    expect(existsSync(logoPath())).toBe(true);
  });
});

describe("language choice", () => {
  it("honours an explicit account preference", () => {
    expect(pickMailLocale("pl", "en-GB,en;q=0.9")).toBe("pl");
    expect(pickMailLocale("en", "pl-PL")).toBe("en");
  });

  it("falls back to Polish only for a Polish browser", () => {
    expect(pickMailLocale(null, "pl-PL,pl;q=0.9")).toBe("pl");
    expect(pickMailLocale(null, "de-DE,de;q=0.9")).toBe("en");
    expect(pickMailLocale(null, null)).toBe("en");
  });
});
