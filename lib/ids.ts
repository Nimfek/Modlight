import { randomInt, randomBytes } from "node:crypto";

/**
 * Short-code generation: pronounceable codes, using cryptographically strong
 * randomness (crypto.randomInt) so public URLs are not
 * enumerable.
 *
 * The original alphabet groups consonants (indices 0..41, both cases) and vowels
 * (indices 42..51, both cases). Codes alternate consonant/vowel for readability
 * and end with a few digits — e.g. "Bocugavi42".
 */
const CONSONANTS = "bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ"; // 42 chars
const VOWELS = "aeiouAEIOU"; // 10 chars
const DIGITS = "0123456789";

function pick(alphabet: string): string {
  return alphabet[randomInt(0, alphabet.length)];
}

/**
 * Pronounceable, hard-to-guess code. Default length 10 (8 letters + 2 digits),
 * the media-code shape ShareX links use. Used for upload `code` and `user_code`.
 */
export function humanCode(length = 10): string {
  const digitCount = Math.max(0, Math.round(length * 0.2));
  const letterCount = length - digitCount;
  let out = "";
  for (let i = 0; i < letterCount; i++) {
    out += i % 2 === 1 ? pick(VOWELS) : pick(CONSONANTS);
  }
  for (let i = 0; i < digitCount; i++) {
    out += pick(DIGITS);
  }
  return out;
}

/** Short per-user code used as the first URL segment. */
export function userCode(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += i % 2 === 1 ? pick(VOWELS) : pick(CONSONANTS);
  }
  return out;
}

/**
 * Vanity slug sanitizer.
 * Lowercases, collapses runs of non-alphanumerics to a single dash, trims dashes.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** URL-safe, high-entropy secret (API tokens, deletion tokens, etc.). */
export function secureToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
