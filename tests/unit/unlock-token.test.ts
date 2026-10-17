import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  checkRateLimit,
  clientIp,
  mintUnlockToken,
  resetRateLimit,
  unlockCookieName,
  unlockCookieOptions,
  verifyUnlockToken,
} from "@/lib/password";

const MEDIA = "9d2e1a54-0000-4000-8000-000000000001";
const OTHER = "9d2e1a54-0000-4000-8000-000000000002";

describe("unlock tokens", () => {
  it("accepts a freshly minted token for the resource it was minted for", () => {
    const token = mintUnlockToken("media", MEDIA);
    expect(verifyUnlockToken(token, "media", MEDIA)).toBe(true);
  });

  it("rejects the flag cookie the gate used to accept", () => {
    // Any visitor can set `ml_unlock_<id>=1` on themselves — the whole reason
    // the value has to be signed.
    expect(verifyUnlockToken("1", "media", MEDIA)).toBe(false);
    expect(verifyUnlockToken("", "media", MEDIA)).toBe(false);
    expect(verifyUnlockToken(null, "media", MEDIA)).toBe(false);
    expect(verifyUnlockToken(undefined, "media", MEDIA)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = mintUnlockToken("media", MEDIA);
    const [exp, sig] = token.split(".");

    // flipped character
    const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(verifyUnlockToken(`${exp}.${flipped}`, "media", MEDIA)).toBe(false);

    // truncated / padded signature must not throw on the constant-time compare
    expect(verifyUnlockToken(`${exp}.${sig.slice(0, -2)}`, "media", MEDIA)).toBe(false);
    expect(verifyUnlockToken(`${exp}.${sig}xx`, "media", MEDIA)).toBe(false);
    expect(verifyUnlockToken(`${exp}.`, "media", MEDIA)).toBe(false);
  });

  it("rejects an extended expiry (the signature covers it)", () => {
    const token = mintUnlockToken("media", MEDIA);
    const sig = token.slice(token.indexOf(".") + 1);
    const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
    expect(verifyUnlockToken(`${farFuture}.${sig}`, "media", MEDIA)).toBe(false);
  });

  it("rejects an expired token", () => {
    const expired = mintUnlockToken("media", MEDIA, -1);
    expect(verifyUnlockToken(expired, "media", MEDIA)).toBe(false);
  });

  it("rejects a token minted for another file", () => {
    const token = mintUnlockToken("media", OTHER);
    expect(verifyUnlockToken(token, "media", MEDIA)).toBe(false);
  });

  it("rejects a token from another scope", () => {
    const token = mintUnlockToken("shortlink", MEDIA);
    expect(verifyUnlockToken(token, "media", MEDIA)).toBe(false);
  });

  it("rejects malformed input instead of throwing", () => {
    for (const junk of ["garbage", ".", ".sig", "abc.def", "-1.sig", "NaN.sig", "1e9.sig"]) {
      expect(verifyUnlockToken(junk, "media", MEDIA), junk).toBe(false);
    }
  });
});

describe("unlock cookies", () => {
  it("namespaces the cookie per scope and resource", () => {
    expect(unlockCookieName("media", MEDIA)).toBe(`ml_unlock_${MEDIA}`);
    expect(unlockCookieName("shortlink", MEDIA)).toBe(`ml_sl_${MEDIA}`);
  });

  it("is httpOnly, lax and scoped to the whole site", () => {
    const opts = unlockCookieOptions("media");
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBe(60 * 60 * 24);
    expect(unlockCookieOptions("shortlink").maxAge).toBe(60 * 60);
  });
});

describe("attempt throttling", () => {
  const key = "203.0.113.9|media:test";

  beforeEach(() => resetRateLimit(key));
  afterEach(() => vi.useRealTimers());

  it("allows the first 5 attempts and refuses the 6th", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(key).allowed, `attempt ${i + 1}`).toBe(true);
    }
    const refused = checkRateLimit(key);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it("keys buckets separately per caller and resource", () => {
    for (let i = 0; i < 6; i++) checkRateLimit(key);
    expect(checkRateLimit("203.0.113.9|media:other").allowed).toBe(true);
    expect(checkRateLimit("198.51.100.4|media:test").allowed).toBe(true);
  });

  it("clears the bucket on a successful unlock", () => {
    for (let i = 0; i < 6; i++) checkRateLimit(key);
    expect(checkRateLimit(key).allowed).toBe(false);
    resetRateLimit(key);
    expect(checkRateLimit(key).allowed).toBe(true);
  });

  it("refills after the window elapses", () => {
    const short = "203.0.113.9|media:short";
    const windowMs = 60_000;
    resetRateLimit(short);

    // The clock is faked so the window elapses on command: a real short window
    // races the scheduler, and under load the second call below lands in an
    // already-refilled bucket.
    vi.useFakeTimers();

    expect(checkRateLimit(short, 1, windowMs).allowed).toBe(true);
    const refused = checkRateLimit(short, 1, windowMs);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(windowMs);

    vi.advanceTimersByTime(windowMs + 1);
    expect(checkRateLimit(short, 1, windowMs).allowed).toBe(true);

    // The bucket map lives on globalThis, so it outlives this file's module registry.
    resetRateLimit(short);
  });
});

describe("clientIp", () => {
  it("uses x-real-ip, which only the reverse proxy can set", () => {
    expect(clientIp(new Headers({ "x-real-ip": " 203.0.113.9 " }))).toBe("203.0.113.9");
  });

  it("ignores the client-appendable X-Forwarded-For", () => {
    // Honoring it would let an attacker hand themselves a fresh bucket per try.
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4" }))).toBe("unknown");
  });
});
