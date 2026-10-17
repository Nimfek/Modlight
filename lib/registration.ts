import { count } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as users } from "@/lib/db/schema";
import { getSetting, isRegistrationEnabled, setSetting } from "@/lib/settings";
import {
  digestsEqual,
  encryptSecret,
  secretDigest,
  tryDecryptSecret,
} from "@/lib/secret-box";
import { checkRateLimit, resetRateLimit } from "@/lib/password";

/**
 * Who is allowed to create an account, and on what terms.
 *
 * The single most important thing in this file is the SEMANTICS, because
 * getting them wrong is what produced the bug this module exists to fix:
 *
 *   `register_enabled` means "a stranger may sign themselves up at /register".
 *   It means nothing else.
 *
 * It is NOT a global "no accounts may be created" switch. An administrator
 * creating an account from the panel is a different act, performed by an
 * already-trusted party through an endpoint that has its own authorisation
 * check, and it must keep working with self-service registration shut. That is
 * why the gate lives here — attached to the `/sign-up/email` path — instead of
 * in `databaseHooks.user.create.before`, which every account-creation path in
 * Better Auth runs through, the admin one included.
 *
 * The bootstrap case is the second exception: on an empty install there is no
 * administrator to invite anybody, so the first account is always allowed and
 * becomes the admin.
 */

// ---------------------------------------------------------------------------
// The decision, as a pure function
// ---------------------------------------------------------------------------

export type SignUpRefusal = "closed" | "key-required" | "key-invalid" | "rate-limited";

export type SignUpDecision = { allow: true } | { allow: false; reason: SignUpRefusal };

export interface SignUpFacts {
  /** No account exists yet: this sign-up creates the administrator. */
  isFirstAccount: boolean;
  /** `settings.register_enabled`. */
  registrationEnabled: boolean;
  /**
   * Digest of the configured registration key, or null when no key is set.
   * A digest rather than the key itself so the comparison below is fixed-width.
   */
  expectedKeyDigest: string | null;
  /**
   * A key IS configured but cannot be read back (the encryption key changed, or
   * the row was tampered with).
   *
   * Carried separately because "no key" and "unreadable key" both arrive as a
   * null digest, and collapsing them is a fail-open: an install whose
   * AUTH_SECRET was rotated would go on rendering the key field and demanding a
   * value while the endpoint let every caller through, key or no key.
   */
  keyUnreadable: boolean;
  /** Digest of what the visitor typed, or null when they sent no key at all. */
  suppliedKeyDigest: string | null;
  /** Whether the caller has already burnt through its attempt budget. */
  rateLimited: boolean;
}

/**
 * Decide a self-service sign-up.
 *
 * Order matters and is deliberate:
 *
 *  1. **Bootstrap wins over everything.** A fresh install with registration off
 *     (the default) would otherwise have no way at all to create its first
 *     administrator short of editing the environment and redeploying.
 *  2. **Rate limit before any secret is looked at**, so a guessing loop is
 *     stopped without the server doing the work of checking each guess.
 *  3. **Closed before key.** A key does NOT open a closed registration: those
 *     are two different questions ("may any stranger in?" and "which stranger?").
 *     If the key could open the door, the registration toggle would stop being
 *     the emergency stop it is meant to be, and an administrator dealing with
 *     abuse would have two levers to find instead of one.
 */
export function decideSignUp(facts: SignUpFacts): SignUpDecision {
  if (facts.isFirstAccount) return { allow: true };
  if (facts.rateLimited) return { allow: false, reason: "rate-limited" };
  if (!facts.registrationEnabled) return { allow: false, reason: "closed" };

  // A key that exists but cannot be read closes the door rather than opening
  // it. Nobody can supply the right value (there is no longer a right value),
  // which is a broken install an administrator must fix by setting a new key —
  // and a broken install that refuses sign-ups is recoverable, whereas one that
  // accepts them silently is not.
  if (facts.keyUnreadable) return { allow: false, reason: "key-invalid" };

  if (facts.expectedKeyDigest === null) return { allow: true };
  if (facts.suppliedKeyDigest === null) return { allow: false, reason: "key-required" };
  if (!digestsEqual(facts.suppliedKeyDigest, facts.expectedKeyDigest)) {
    return { allow: false, reason: "key-invalid" };
  }
  return { allow: true };
}

// ---------------------------------------------------------------------------
// The registration key
// ---------------------------------------------------------------------------

export const REGISTRATION_KEY_MAX = 200;

/**
 * Stored ENCRYPTED rather than hashed, unlike a password, and the difference is
 * one of purpose: this key exists to be handed out. An administrator has to be
 * able to read it back to put it in an invitation, and a key that can only be
 * replaced turns "what was our key again?" into "everyone gets a new one".
 *
 * The threat it defends against is therefore not an attacker with the database
 * (who already owns the install) but an attacker with a backup, a log file or a
 * screenshot of the admin page. Encryption at rest covers all three.
 */
export async function setRegistrationKey(key: string | null): Promise<void> {
  const trimmed = key?.trim() ?? "";
  await setSetting("registration_key_enc", trimmed ? encryptSecret(trimmed, "registration-key") : null);
}

/** The plaintext key, or null when none is set / it can no longer be decrypted. */
export async function readRegistrationKey(): Promise<string | null> {
  const box = await getSetting("registration_key_enc");
  const res = tryDecryptSecret(box, "registration-key");
  return res.ok ? res.value : null;
}

export type RegistrationKeyState = "unset" | "set" | "undecryptable";

/** What the panel is allowed to know: a state, never the value. */
export async function registrationKeyState(): Promise<RegistrationKeyState> {
  const box = await getSetting("registration_key_enc");
  if (!box) return "unset";
  return tryDecryptSecret(box, "registration-key").ok ? "set" : "undecryptable";
}

/**
 * Does /register need to render a key field?
 *
 * Answered on the server so the input is CONDITIONALLY RENDERED rather than
 * hidden with CSS: a field that exists in the DOM but is invisible still tells
 * every visitor that a key exists, and still submits whatever is in it.
 *
 * An undecryptable key counts as required. The alternative is worse: silently
 * letting everyone in because the encryption key changed.
 */
export async function isRegistrationKeyRequired(): Promise<boolean> {
  return (await registrationKeyState()) !== "unset";
}

// ---------------------------------------------------------------------------
// Wiring it to a request
// ---------------------------------------------------------------------------

/** Is the users table empty? Used for the bootstrap exception. */
export async function isFirstAccount(): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(users);
  return Number(row?.n ?? 0) === 0;
}

/**
 * May /register show a sign-up form at all?
 *
 * Same two-part answer as the gate itself, so the page and the endpoint can
 * never disagree: an empty install always shows the form (bootstrap), otherwise
 * the stored flag decides.
 */
export async function registrationPageState(): Promise<{
  open: boolean;
  bootstrap: boolean;
  keyRequired: boolean;
}> {
  const [bootstrap, enabled, keyRequired] = await Promise.all([
    isFirstAccount(),
    isRegistrationEnabled(),
    isRegistrationKeyRequired(),
  ]);
  return {
    open: bootstrap || enabled,
    bootstrap,
    // The first account is the administrator setting the key up; asking them
    // for a key that nobody has yet set would be a closed loop.
    keyRequired: keyRequired && !bootstrap,
  };
}

/** Key attempts allowed per caller, and the window they are counted over. */
const KEY_ATTEMPTS = 5;
const KEY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Evaluate one sign-up attempt.
 *
 * `clientIp` is passed in rather than read here so this stays usable from the
 * Better Auth middleware, from a test, and from anywhere else that can identify
 * a caller.
 *
 * The throttle is scoped to installs that HAVE a key, deliberately. Its job is
 * to stop somebody guessing a shared secret, and where there is no secret there
 * is nothing to guess: throttling open registration on top of Better Auth's own
 * per-path limit would only punish a team signing up together from one office
 * address. The bootstrap account is exempt for the same reason at greater
 * cost - it is the one sign-up an install cannot afford to have blocked.
 */
export async function evaluateSignUp(input: {
  clientIp: string;
  suppliedKey: string | null | undefined;
}): Promise<SignUpDecision> {
  const [bootstrap, enabled, keyState, expectedKey] = await Promise.all([
    isFirstAccount(),
    isRegistrationEnabled(),
    // Read the STATE as well as the value: `readRegistrationKey` cannot tell
    // "unset" from "unreadable" on its own, and the two must not decide alike.
    registrationKeyState(),
    readRegistrationKey(),
  ]);

  const throttleKey = `${input.clientIp}|signup-key`;
  const rateLimited =
    !bootstrap && expectedKey
      ? !checkRateLimit(throttleKey, KEY_ATTEMPTS, KEY_WINDOW_MS).allowed
      : false;

  const supplied = typeof input.suppliedKey === "string" ? input.suppliedKey.trim() : "";
  // Digested unconditionally: a correct key and a wrong key of any length must
  // cost the same, and `digestsEqual` can only be constant-time over inputs
  // that are already the same fixed width.
  const suppliedDigest = secretDigest(supplied, "registration-key");

  const decision = decideSignUp({
    isFirstAccount: bootstrap,
    registrationEnabled: enabled,
    expectedKeyDigest: expectedKey ? secretDigest(expectedKey, "registration-key") : null,
    keyUnreadable: keyState === "undecryptable",
    suppliedKeyDigest: supplied ? suppliedDigest : null,
    rateLimited,
  });

  // A correct key clears the budget, so onboarding five colleagues from one
  // office does not lock out the sixth.
  if (decision.allow && expectedKey) resetRateLimit(throttleKey);

  return decision;
}
