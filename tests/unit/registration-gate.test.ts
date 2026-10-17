import { describe, it, expect } from "vitest";
import { decideSignUp, type SignUpFacts } from "@/lib/registration";
import { secretDigest } from "@/lib/secret-box";

/**
 * The decision that produced the bug report: "why do I have to switch
 * registration ON in order to create one account as an administrator?".
 *
 * The answer was that one flag was being asked two different questions. These
 * tests pin down which question it now answers, so the two cannot be conflated
 * again by accident.
 */

const KEY = "shared-key-for-the-team";
const digest = (v: string) => secretDigest(v, "registration-key");

function facts(over: Partial<SignUpFacts> = {}): SignUpFacts {
  return {
    isFirstAccount: false,
    registrationEnabled: true,
    expectedKeyDigest: null,
    keyUnreadable: false,
    suppliedKeyDigest: null,
    rateLimited: false,
    ...over,
  };
}

describe("self-service sign-up decision", () => {
  it("lets a stranger in when registration is open and no key is set", () => {
    expect(decideSignUp(facts())).toEqual({ allow: true });
  });

  it("refuses a stranger when registration is closed", () => {
    expect(decideSignUp(facts({ registrationEnabled: false }))).toEqual({
      allow: false,
      reason: "closed",
    });
  });

  it("always allows the very first account, whatever the flag says", () => {
    // Otherwise a fresh install with the default (registration off) has no way
    // to create its administrator except editing the environment and
    // redeploying, which is exactly what the user hit.
    expect(decideSignUp(facts({ isFirstAccount: true, registrationEnabled: false }))).toEqual({
      allow: true,
    });
  });

  it("does not ask the first account for a key it could not have been given", () => {
    expect(
      decideSignUp(
        facts({ isFirstAccount: true, registrationEnabled: false, expectedKeyDigest: digest(KEY) }),
      ),
    ).toEqual({ allow: true });
  });
});

describe("registration key", () => {
  it("accepts the right key", () => {
    expect(
      decideSignUp(facts({ expectedKeyDigest: digest(KEY), suppliedKeyDigest: digest(KEY) })),
    ).toEqual({ allow: true });
  });

  it("rejects a wrong key", () => {
    expect(
      decideSignUp(facts({ expectedKeyDigest: digest(KEY), suppliedKeyDigest: digest("nope") })),
    ).toEqual({ allow: false, reason: "key-invalid" });
  });

  it("rejects a missing key when one is configured", () => {
    expect(decideSignUp(facts({ expectedKeyDigest: digest(KEY) }))).toEqual({
      allow: false,
      reason: "key-required",
    });
  });

  it("ignores a key that was sent when none is configured", () => {
    // The field is not rendered in that case, but a hand-crafted request can
    // still carry one and must not be treated as an error.
    expect(decideSignUp(facts({ suppliedKeyDigest: digest("anything") }))).toEqual({ allow: true });
  });

  it("fails CLOSED when the configured key can no longer be decrypted", () => {
    // The dangerous shape: `readRegistrationKey()` returns null both for "no key
    // set" and for "key unreadable", and a null expected digest means "no key,
    // let them in". So rotating AUTH_SECRET would have left /register still
    // rendering the field and still demanding a value while the endpoint
    // admitted everybody — the install would look protected and not be.
    expect(decideSignUp(facts({ keyUnreadable: true }))).toEqual({
      allow: false,
      reason: "key-invalid",
    });
  });

  it("does not let a supplied key past an unreadable one", () => {
    expect(
      decideSignUp(facts({ keyUnreadable: true, suppliedKeyDigest: digest(KEY) })),
    ).toEqual({ allow: false, reason: "key-invalid" });
  });

  it("still lets the first account through an unreadable key", () => {
    // Bootstrap has to survive a broken key, or an install whose encryption key
    // was rotated before anybody registered could never create its admin.
    expect(decideSignUp(facts({ isFirstAccount: true, keyUnreadable: true }))).toEqual({
      allow: true,
    });
  });

  it("does NOT open a closed registration", () => {
    // Two separate questions: "may any stranger in?" and "which stranger?".
    // If a key answered the first, the registration toggle would stop being an
    // emergency stop and an administrator would have two levers to find.
    expect(
      decideSignUp(
        facts({
          registrationEnabled: false,
          expectedKeyDigest: digest(KEY),
          suppliedKeyDigest: digest(KEY),
        }),
      ),
    ).toEqual({ allow: false, reason: "closed" });
  });
});

describe("throttling", () => {
  it("refuses before the key is even looked at", () => {
    expect(
      decideSignUp(
        facts({
          rateLimited: true,
          expectedKeyDigest: digest(KEY),
          suppliedKeyDigest: digest(KEY),
        }),
      ),
    ).toEqual({ allow: false, reason: "rate-limited" });
  });

  it("does not throttle the bootstrap account", () => {
    expect(decideSignUp(facts({ isFirstAccount: true, rateLimited: true }))).toEqual({
      allow: true,
    });
  });
});
