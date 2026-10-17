import { describe, it, expect } from "vitest";
import {
  decryptSecret,
  digestsEqual,
  encryptSecret,
  redactSecrets,
  secretDigest,
  smtpSecretForms,
  tryDecryptSecret,
} from "@/lib/secret-box";

/**
 * The properties that make storing a credential in the `settings` table
 * acceptable at all. Each test here corresponds to a way the previous design
 * (plaintext in a row that the admin page shipped to the browser) failed.
 */
describe("secret box", () => {
  it("round-trips a secret", () => {
    const box = encryptSecret("hunter2-not-a-real-password", "smtp");
    expect(box.startsWith("v1.")).toBe(true);
    expect(decryptSecret(box, "smtp")).toBe("hunter2-not-a-real-password");
  });

  it("never stores the plaintext in the envelope", () => {
    const box = encryptSecret("recognisable-plaintext", "smtp");
    expect(box).not.toContain("recognisable-plaintext");
  });

  it("produces a different envelope every time", () => {
    // A deterministic ciphertext would let anyone with the table see that two
    // installs, or two versions of a row, share a password.
    const a = encryptSecret("same", "smtp");
    const b = encryptSecret("same", "smtp");
    expect(a).not.toBe(b);
  });

  it("rejects a tampered ciphertext instead of returning garbage", () => {
    const box = encryptSecret("original", "smtp");
    const parts = box.split(".");
    // Flip one character of the ciphertext.
    parts[3] = parts[3].startsWith("A") ? `B${parts[3].slice(1)}` : `A${parts[3].slice(1)}`;
    expect(() => decryptSecret(parts.join("."), "smtp")).toThrow();
  });

  it("refuses a truncated envelope", () => {
    expect(() => decryptSecret("v1.abc", "smtp")).toThrow();
    expect(() => decryptSecret("nonsense", "smtp")).toThrow();
  });

  it("keeps purposes independent, so one derived key cannot read another", () => {
    const box = encryptSecret("shared-text", "smtp");
    expect(tryDecryptSecret(box, "registration-key").ok).toBe(false);
  });

  it("reports an unreadable secret rather than pretending it is empty", () => {
    const res = tryDecryptSecret("v1.AAAA.BBBB.CCCC", "smtp");
    expect(res.ok).toBe(false);
  });
});

describe("digest comparison", () => {
  it("matches a value against itself and nothing else", () => {
    const a = secretDigest("correct-key", "registration-key");
    expect(digestsEqual(a, secretDigest("correct-key", "registration-key"))).toBe(true);
    expect(digestsEqual(a, secretDigest("correct-keys", "registration-key"))).toBe(false);
  });

  it("produces a fixed width whatever the input length", () => {
    // This is what makes the comparison constant-time: timingSafeEqual cannot
    // be used on inputs of differing length, and padding would leak the length.
    const short = secretDigest("a", "registration-key");
    const long = secretDigest("a".repeat(500), "registration-key");
    expect(short.length).toBe(long.length);
  });
});

describe("redaction", () => {
  const password = "s3cr3t-smtp-password";

  it("removes the plaintext password", () => {
    const out = redactSecrets(`535 auth failed for ${password}`, [password]);
    expect(out).not.toContain(password);
    expect(out).toContain("***");
  });

  it("removes the base64 form a server may echo back", () => {
    const b64 = Buffer.from(password, "utf8").toString("base64");
    const out = redactSecrets(`501 malformed line: ${b64}`, [password]);
    expect(out).not.toContain(b64);
  });

  it("removes the AUTH PLAIN payload", () => {
    const forms = smtpSecretForms("postmaster@example.test", password);
    const authPlain = forms[1];
    const out = redactSecrets(`500 unrecognised: ${authPlain}`, forms);
    expect(out).not.toContain(authPlain);
    expect(out).not.toContain(password);
  });

  it("leaves an ordinary message alone", () => {
    const msg = "535 5.7.8 Username and Password not accepted";
    expect(redactSecrets(msg, [password])).toBe(msg);
  });

  it("ignores empty secrets rather than redacting everything", () => {
    const msg = "connection refused";
    expect(redactSecrets(msg, ["", null, undefined])).toBe(msg);
  });
});
