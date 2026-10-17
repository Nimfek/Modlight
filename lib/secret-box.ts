import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "@/lib/config";

/**
 * Authenticated encryption for the handful of secrets that have to live in the
 * `settings` table: the SMTP password and the registration key.
 *
 * Three decisions worth writing down, because each of them is the answer to a
 * concrete failure rather than a preference:
 *
 *  1. **HKDF, not AUTH_SECRET used directly as a key.** The same secret signs
 *     session cookies, unlock tokens (lib/password.ts) and render tickets. A
 *     context label makes the key that encrypts an SMTP password mathematically
 *     independent of the one that signs a session, so a flaw that leaks one
 *     derived key does not hand over the others.
 *
 *  2. **GCM, not CBC.** The ciphertext sits in a row that anybody with database
 *     access can rewrite. Without an authentication tag a swapped ciphertext
 *     would decrypt to garbage that we would then send to an SMTP server as a
 *     password. The tag turns that into a loud failure.
 *
 *  3. **SETTINGS_ENCRYPTION_KEY as an optional override.** Rotating AUTH_SECRET
 *     is a security operation nobody should be afraid of. If the encryption key
 *     hangs off it, rotation silently invalidates the stored SMTP password and
 *     the install discovers that the next time somebody clicks "forgot my
 *     password". A separate key lets the two be rotated independently.
 */

const VERSION = "v1";

/**
 * HKDF salt. Not a secret and deliberately constant: its job is domain
 * separation between deployments' derived keys, and the input keying material
 * (AUTH_SECRET) already carries all the entropy.
 */
const SALT = Buffer.from("modlight/secret-box/2026", "utf8");

/** Context labels. A new purpose gets a new label, never a reused one. */
export type SecretPurpose = "smtp" | "registration-key";

const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

function rawKeyMaterial(): Buffer {
  const override = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (override) {
    const buf = Buffer.from(override, "base64");
    // A short key here is not a weak key, it is a typo: base64 of 32 random
    // bytes is 44 characters and anything else means the operator pasted
    // something else entirely.
    if (buf.length !== 32) {
      throw new SecretBoxError(
        "SETTINGS_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded (generate one with `openssl rand -base64 32`).",
      );
    }
    return buf;
  }
  return Buffer.from(config.auth.secret, "utf8");
}

function keyFor(purpose: SecretPurpose): Buffer {
  const info = `modlight:${purpose}:${VERSION}`;
  return Buffer.from(hkdfSync("sha256", rawKeyMaterial(), SALT, Buffer.from(info, "utf8"), 32));
}

/** Encrypt to `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string, purpose: SecretPurpose): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(purpose), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(
    ".",
  );
}

/** Decrypt a box produced by `encryptSecret`. Throws on any tampering. */
export function decryptSecret(box: string, purpose: SecretPurpose): string {
  const parts = box.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretBoxError("Unrecognised secret format.");
  }
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ct = Buffer.from(parts[3], "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError("Malformed secret envelope.");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(purpose), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or altered ciphertext. Both mean the same thing to a caller:
    // what is stored can no longer be read, and pretending otherwise (returning
    // "" and sending it as a password) produces an unexplainable EAUTH loop.
    throw new SecretBoxError("Stored secret could not be decrypted.");
  }
}

/** Non-throwing form, for the read paths that must report a state instead. */
export function tryDecryptSecret(
  box: string | null | undefined,
  purpose: SecretPurpose,
): { ok: true; value: string } | { ok: false } {
  if (!box) return { ok: false };
  try {
    return { ok: true, value: decryptSecret(box, purpose) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Constant-time comparison of user-supplied secrets
// ---------------------------------------------------------------------------

/**
 * Fingerprint used to compare two secrets without leaking their length.
 *
 * `timingSafeEqual` throws on a length mismatch, so comparing raw strings means
 * either an early return (which leaks the length through timing) or padding.
 * Hashing both sides first makes every comparison a fixed 32-byte one.
 */
export function secretDigest(value: string, purpose: SecretPurpose): string {
  return createHmac("sha256", keyFor(purpose)).update(value, "utf8").digest("base64url");
}

/** Constant-time equality over two digests produced by `secretDigest`. */
export function digestsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Strip credentials out of anything that may reach a log line, an audit entry
 * or the browser.
 *
 * SMTP is the reason this is not a single string replace: clients send
 * `AUTH LOGIN` / `AUTH PLAIN` base64-encoded, and servers happily echo a chunk
 * of the offending line back inside the error text. So the password has to be
 * removed in every encoding it could plausibly appear in.
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of encodings(secret)) {
      if (form.length < 4) continue; // too short to match anything but noise
      out = out.split(form).join("***");
    }
  }
  return out;
}

function encodings(secret: string): string[] {
  const b64 = Buffer.from(secret, "utf8").toString("base64");
  return [
    secret,
    b64,
    b64.replace(/=+$/, ""), // some servers echo the padding-stripped form
    Buffer.from(secret, "utf8").toString("base64url"),
  ];
}

/**
 * Everything a redaction pass should consider secret for one SMTP attempt:
 * the password on its own, plus the AUTH PLAIN payload built from it.
 */
export function smtpSecretForms(user: string, password: string): string[] {
  if (!password) return [];
  const authPlain = Buffer.from(`\0${user}\0${password}`, "utf8").toString("base64");
  return [password, authPlain];
}
