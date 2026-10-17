import { describe, it, expect } from "vitest";
import {
  REMEMBER_TTL,
  isMediaUnlocked,
  mintOwnerUnlockToken,
  mintUnlockToken,
  ownerUnlockCookieName,
  unlockCookieName,
  unlockCookieOptions,
  verifyOwnerUnlockToken,
  type MediaUnlockSubject,
} from "@/lib/password";

const OWNER = "usr_2f8a1c94";
const OTHER_OWNER = "usr_9b3e77d1";
const FILE_A = "9d2e1a54-0000-4000-8000-00000000000a";
const FILE_B = "9d2e1a54-0000-4000-8000-00000000000b";

/** A file stamped with generation `v` of its owner's default password. */
function onDefault(mediaId: string, v: number, ownerId = OWNER): MediaUnlockSubject {
  return { mediaId, ownerId, passwordVersion: v };
}

/** A file whose password was typed for it alone. */
function handPicked(mediaId: string, ownerId = OWNER): MediaUnlockSubject {
  return { mediaId, ownerId, passwordVersion: null };
}

/** Cookie jar stub: name -> value. */
function jar(cookies: Record<string, string>) {
  return (name: string) => cookies[name];
}

describe("owner-scoped unlock tokens", () => {
  it("accepts a token for the owner and generation it was minted for", () => {
    const token = mintOwnerUnlockToken(OWNER, 3);
    expect(verifyOwnerUnlockToken(token, OWNER, 3)).toBe(true);
  });

  it("rejects an unsigned value", () => {
    // The whole reason the cookie carries a signature: any visitor can set
    // `ml_dpw_<ownerId>=1` on themselves.
    for (const junk of ["1", "", "garbage", "abc.def", ".sig"]) {
      expect(verifyOwnerUnlockToken(junk, OWNER, 0), junk).toBe(false);
    }
    expect(verifyOwnerUnlockToken(null, OWNER, 0)).toBe(false);
    expect(verifyOwnerUnlockToken(undefined, OWNER, 0)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = mintOwnerUnlockToken(OWNER, 1);
    const [exp, sig] = token.split(".");
    const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(verifyOwnerUnlockToken(`${exp}.${flipped}`, OWNER, 1)).toBe(false);
    // Truncated / padded must be refused by the constant-time compare, not throw.
    expect(verifyOwnerUnlockToken(`${exp}.${sig.slice(0, -2)}`, OWNER, 1)).toBe(false);
    expect(verifyOwnerUnlockToken(`${exp}.${sig}xx`, OWNER, 1)).toBe(false);
  });

  it("rejects an extended expiry, because the signature covers it", () => {
    const token = mintOwnerUnlockToken(OWNER, 1);
    const sig = token.slice(token.indexOf(".") + 1);
    const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
    expect(verifyOwnerUnlockToken(`${farFuture}.${sig}`, OWNER, 1)).toBe(false);
  });

  it("rejects an expired token", () => {
    expect(verifyOwnerUnlockToken(mintOwnerUnlockToken(OWNER, 1, -1), OWNER, 1)).toBe(false);
  });

  it("rejects a token minted for a different generation of the password", () => {
    // This is what makes changing the default password revoke remembered consent.
    const token = mintOwnerUnlockToken(OWNER, 1);
    expect(verifyOwnerUnlockToken(token, OWNER, 2)).toBe(false);
    expect(verifyOwnerUnlockToken(token, OWNER, 0)).toBe(false);
  });

  it("rejects a token minted for a different owner", () => {
    const token = mintOwnerUnlockToken(OTHER_OWNER, 1);
    expect(verifyOwnerUnlockToken(token, OWNER, 1)).toBe(false);
  });

  it("refuses a nonsensical generation instead of signing one", () => {
    expect(verifyOwnerUnlockToken(mintOwnerUnlockToken(OWNER, 0), OWNER, null)).toBe(false);
    expect(verifyOwnerUnlockToken(mintOwnerUnlockToken(OWNER, 0), OWNER, -1)).toBe(false);
    expect(verifyOwnerUnlockToken(mintOwnerUnlockToken(OWNER, 0), OWNER, 1.5)).toBe(false);
    expect(verifyOwnerUnlockToken(mintOwnerUnlockToken(OWNER, 0), null, 0)).toBe(false);
    expect(() => mintOwnerUnlockToken(OWNER, -1)).toThrow();
  });

  it("does not confuse an owner token with a file token", () => {
    const ownerToken = mintOwnerUnlockToken(FILE_A, 0);
    // Same string in the id slot, different scope -> different signature.
    expect(isMediaUnlocked(handPicked(FILE_A), jar({ [unlockCookieName("media", FILE_A)]: ownerToken }))).toBe(
      false,
    );
  });
});

describe("who gets in", () => {
  it("lets a file token open its own file", () => {
    const cookies = { [unlockCookieName("media", FILE_A)]: mintUnlockToken("media", FILE_A) };
    expect(isMediaUnlocked(handPicked(FILE_A), jar(cookies))).toBe(true);
  });

  it("does not let a file token open another file", () => {
    const cookies = { [unlockCookieName("media", FILE_A)]: mintUnlockToken("media", FILE_A) };
    expect(isMediaUnlocked(handPicked(FILE_B), jar(cookies))).toBe(false);
    expect(isMediaUnlocked(onDefault(FILE_B, 0), jar(cookies))).toBe(false);
  });

  it("lets a remembered owner token open every file on that same default", () => {
    // A visitor unlocked one of the owner's files and ticked "remember me for 30 days".
    const cookies = { [ownerUnlockCookieName(OWNER)]: mintOwnerUnlockToken(OWNER, 0) };
    expect(isMediaUnlocked(onDefault(FILE_A, 0), jar(cookies))).toBe(true);
    expect(isMediaUnlocked(onDefault(FILE_B, 0), jar(cookies))).toBe(true);
  });

  it("NEVER lets an owner token open a file with a hand-picked password", () => {
    // The scenario the design exists for: the owner gave this one file a different
    // password, so the visitor has to be asked even though they remembered the default.
    const cookies = { [ownerUnlockCookieName(OWNER)]: mintOwnerUnlockToken(OWNER, 0) };
    expect(isMediaUnlocked(handPicked(FILE_A), jar(cookies))).toBe(false);
  });

  it("stops opening files once the owner changes their default password", () => {
    // Cookie from generation 0; the owner has since rotated, so new uploads
    // record generation 1 and the old consent matches none of them.
    const cookies = { [ownerUnlockCookieName(OWNER)]: mintOwnerUnlockToken(OWNER, 0) };
    expect(isMediaUnlocked(onDefault(FILE_B, 1), jar(cookies))).toBe(false);
  });

  it("does not let one owner's remembered consent open another owner's files", () => {
    const cookies = { [ownerUnlockCookieName(OTHER_OWNER)]: mintOwnerUnlockToken(OTHER_OWNER, 0) };
    expect(isMediaUnlocked(onDefault(FILE_A, 0, OWNER), jar(cookies))).toBe(false);
  });

  it("refuses a forged owner cookie", () => {
    const cookies = { [ownerUnlockCookieName(OWNER)]: "1" };
    expect(isMediaUnlocked(onDefault(FILE_A, 0), jar(cookies))).toBe(false);
  });

  it("refuses an expired owner cookie", () => {
    const cookies = { [ownerUnlockCookieName(OWNER)]: mintOwnerUnlockToken(OWNER, 0, -1) };
    expect(isMediaUnlocked(onDefault(FILE_A, 0), jar(cookies))).toBe(false);
  });

  it("keeps an orphaned file shut even with a matching-looking cookie", () => {
    const cookies = { [ownerUnlockCookieName(OWNER)]: mintOwnerUnlockToken(OWNER, 0) };
    const orphan = { mediaId: FILE_A, ownerId: null, passwordVersion: 0 };
    expect(isMediaUnlocked(orphan, jar(cookies))).toBe(false);
  });

  it("stays shut when no cookies were sent at all", () => {
    expect(isMediaUnlocked(onDefault(FILE_A, 0), jar({}))).toBe(false);
    expect(isMediaUnlocked(handPicked(FILE_A), jar({}))).toBe(false);
  });
});

describe("cookies", () => {
  it("namespaces the owner cookie away from the per-file one", () => {
    expect(ownerUnlockCookieName(OWNER)).toBe(`ml_dpw_${OWNER}`);
    expect(unlockCookieName("owner", OWNER)).toBe(`ml_dpw_${OWNER}`);
    expect(unlockCookieName("media", FILE_A)).toBe(`ml_unlock_${FILE_A}`);
  });

  it("carries the owner consent for 30 days, httpOnly and lax", () => {
    const opts = unlockCookieOptions("owner");
    expect(opts.maxAge).toBe(REMEMBER_TTL);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
  });

  it("lets a remembered per-file unlock outlive the default day", () => {
    expect(unlockCookieOptions("media").maxAge).toBe(60 * 60 * 24);
    expect(unlockCookieOptions("media", REMEMBER_TTL).maxAge).toBe(REMEMBER_TTL);
  });
});
