import { describe, it, expect } from "vitest";
import {
  mailFingerprint,
  resolveMailSettings,
  type EnvMail,
} from "@/lib/mail-settings";
import { PANEL_SETTINGS, SECRET_SETTINGS } from "@/lib/settings";

/**
 * Which configuration wins, and what must never leak between the two sources.
 *
 * The precedence rule is a security decision rather than a tidiness one, so it
 * is tested as one: a per-field merge would let an administrator who changed
 * only the hostname send the .env credentials to the server they just named.
 */

const ENV: EnvMail = {
  host: "smtp.env.invalid",
  port: 2525,
  user: "env-user",
  password: "env-password",
  secure: true,
  security: null,
  from: "env@example.invalid",
  fromName: "Env Sender",
};

/** Stand-in for the real AES-GCM box: the precedence rule does not need it. */
const decrypt = (box: string) => (box === "BROKEN" ? null : box.replace(/^enc:/, ""));

describe("configuration source", () => {
  it("falls back to the environment when no row exists", () => {
    const r = resolveMailSettings({}, ENV, decrypt);
    expect(r.source).toBe("env");
    expect(r.host).toBe("smtp.env.invalid");
    expect(r.user).toBe("env-user");
    expect(r.password).toBe("env-password");
    expect(r.ready).toBe(true);
  });

  it("reports 'none' when neither source is configured", () => {
    const r = resolveMailSettings({}, { ...ENV, host: "" }, decrypt);
    expect(r.source).toBe("none");
    expect(r.ready).toBe(false);
  });

  it("takes the WHOLE block from the panel once a host is stored", () => {
    const r = resolveMailSettings(
      {
        smtp_host: "smtp.panel.invalid",
        smtp_port: "587",
        smtp_security: "starttls",
        smtp_user: "panel-user",
        smtp_password_enc: "enc:panel-password",
        mail_from: "panel@example.invalid",
      },
      ENV,
      decrypt,
    );
    expect(r.source).toBe("panel");
    expect(r.host).toBe("smtp.panel.invalid");
    expect(r.port).toBe(587);
    expect(r.security).toBe("starttls");
    expect(r.user).toBe("panel-user");
    expect(r.password).toBe("panel-password");
    expect(r.from).toBe("panel@example.invalid");
  });

  it("never lets an environment credential leak into a panel block", () => {
    // The whole point of block precedence: an admin who fills in only the host
    // must not have SMTP_USER/SMTP_PASSWORD from .env sent to that host.
    const r = resolveMailSettings({ smtp_host: "smtp.panel.invalid" }, ENV, decrypt);
    expect(r.source).toBe("panel");
    expect(r.user).toBe("");
    expect(r.password).toBe("");
    expect(r.password).not.toBe(ENV.password);
  });

  it("treats an unreadable password as unusable, not as no password", () => {
    // Sending an empty string where a credential is expected produces an
    // unexplainable authentication loop instead of a diagnosable failure.
    const r = resolveMailSettings(
      { smtp_host: "smtp.panel.invalid", smtp_user: "panel-user", smtp_password_enc: "BROKEN" },
      ENV,
      decrypt,
    );
    expect(r.passwordState).toBe("undecryptable");
    expect(r.ready).toBe(false);
  });

  it("allows an unauthenticated relay (no user, no password)", () => {
    const r = resolveMailSettings({ smtp_host: "relay.internal.invalid" }, ENV, decrypt);
    expect(r.ready).toBe(true);
    expect(r.passwordState).toBe("unset");
  });

  it("maps SMTP_SECURE to implicit TLS, and its absence to opportunistic", () => {
    // "starttls" would add requireTLS and start refusing servers an existing
    // env-configured install already talks to.
    expect(resolveMailSettings({}, ENV, decrypt).security).toBe("tls");
    expect(resolveMailSettings({}, { ...ENV, secure: false }, decrypt).security).toBe("none");
  });
});

describe("address confirmation", () => {
  it("is off unless switched on", () => {
    expect(resolveMailSettings({}, ENV, decrypt).verificationRequired).toBe(false);
  });

  it("follows the stored switch when mail works", () => {
    const r = resolveMailSettings({ email_verification_required: "on" }, ENV, decrypt);
    expect(r.verificationRequired).toBe(true);
  });

  it("is forced off when mail cannot be sent", () => {
    // Requiring a confirmation that can never be delivered locks every new
    // account out of the install.
    const r = resolveMailSettings(
      { email_verification_required: "on" },
      { ...ENV, host: "" },
      decrypt,
    );
    expect(r.verificationRequired).toBe(false);
  });
});

describe("transport fingerprint", () => {
  const base = resolveMailSettings(
    {
      smtp_host: "smtp.panel.invalid",
      smtp_user: "panel-user",
      smtp_password_enc: "enc:first-password",
    },
    ENV,
    decrypt,
  );

  it("changes when only the password changes, so the pool is rebuilt", () => {
    const next = resolveMailSettings(
      {
        smtp_host: "smtp.panel.invalid",
        smtp_user: "panel-user",
        smtp_password_enc: "enc:second-password",
      },
      ENV,
      decrypt,
    );
    expect(mailFingerprint(next)).not.toBe(mailFingerprint(base));
  });

  it("is stable for an unchanged configuration", () => {
    const same = resolveMailSettings(
      {
        smtp_host: "smtp.panel.invalid",
        smtp_user: "panel-user",
        smtp_password_enc: "enc:first-password",
      },
      ENV,
      decrypt,
    );
    expect(mailFingerprint(same)).toBe(mailFingerprint(base));
  });

  it("never contains the password itself", () => {
    // Fingerprints end up in debug output; one carrying a credential is a
    // credential in a log.
    expect(mailFingerprint(base)).not.toContain("first-password");
  });
});

describe("what may reach the browser", () => {
  it("keeps every secret key out of the panel allowlist", () => {
    // The admin page passes its settings straight into a client component, so
    // anything on this list is serialised into the RSC payload.
    for (const secret of SECRET_SETTINGS) {
      expect(PANEL_SETTINGS as readonly string[]).not.toContain(secret);
    }
  });

  it("has no key whose name suggests a stored secret", () => {
    for (const key of PANEL_SETTINGS) {
      expect(key.endsWith("_enc"), key).toBe(false);
      expect(key.includes("password"), key).toBe(false);
    }
  });
});
