import { describe, it, expect } from "vitest";
import { remainingQuota, quotaFits } from "@/lib/upload/finalize";
import { tusMaxSize } from "@/lib/upload/tus";

const GIB = 1024 ** 3;

describe("remainingQuota", () => {
  it("treats -1 as unlimited", () => {
    expect(remainingQuota({ usedQuota: 8 * GIB, maxQuota: -1 })).toBeNull();
  });

  it("treats a missing quota as unlimited", () => {
    expect(remainingQuota({})).toBeNull();
    expect(remainingQuota({ usedQuota: 100, maxQuota: null })).toBeNull();
  });

  it("returns what is left of a real quota", () => {
    // Production defaults: 20 GiB per account, one user sitting at 8.49 GiB.
    expect(remainingQuota({ usedQuota: 9_121_020_000, maxQuota: 20 * GIB })).toBe(
      20 * GIB - 9_121_020_000,
    );
  });

  it("never reports a negative remainder for an over-quota account", () => {
    // Possible after an admin lowers a limit below current usage.
    expect(remainingQuota({ usedQuota: 30 * GIB, maxQuota: 20 * GIB })).toBe(0);
  });

  it("survives byte counts past int4, which is why the columns are bigint", () => {
    const used = 10_551_065_082; // exact production SUM(size)
    expect(remainingQuota({ usedQuota: used, maxQuota: 50 * GIB })).toBe(50 * GIB - used);
  });
});

describe("quotaFits", () => {
  const owner = { usedQuota: 19 * GIB, maxQuota: 20 * GIB };

  it("accepts an upload that exactly fills the quota", () => {
    expect(quotaFits(owner, GIB)).toBe(true);
  });

  it("rejects an upload one byte too large", () => {
    expect(quotaFits(owner, GIB + 1)).toBe(false);
  });

  it("accepts anything for an unlimited account", () => {
    // The biggest file in production is 2020 MiB; unlimited must not cap it.
    expect(quotaFits({ usedQuota: 0, maxQuota: -1 }, 2020 * 1024 * 1024)).toBe(true);
  });
});

describe("tusMaxSize", () => {
  const NO_HARD_MAX = 0; // tus convention: 0 means "no limit"

  it("passes the global ceiling through for unlimited accounts", () => {
    expect(tusMaxSize({ maxQuota: -1 }, NO_HARD_MAX)).toBe(0);
    expect(tusMaxSize({ maxQuota: -1 }, 5 * GIB)).toBe(5 * GIB);
  });

  it("caps an upload at the account's remaining quota", () => {
    expect(tusMaxSize({ usedQuota: 15 * GIB, maxQuota: 20 * GIB }, NO_HARD_MAX)).toBe(5 * GIB);
  });

  it("takes whichever of quota and global ceiling is stricter", () => {
    expect(tusMaxSize({ usedQuota: 15 * GIB, maxQuota: 20 * GIB }, 1 * GIB)).toBe(1 * GIB);
    expect(tusMaxSize({ usedQuota: 19 * GIB, maxQuota: 20 * GIB }, 5 * GIB)).toBe(1 * GIB);
  });

  it("never returns 0 for a full account — tus would read that as unlimited", () => {
    // This is the whole point of the clamp: a user at their limit must get a
    // rejection, not an unbounded upload.
    expect(tusMaxSize({ usedQuota: 20 * GIB, maxQuota: 20 * GIB }, NO_HARD_MAX)).toBe(1);
    expect(tusMaxSize({ usedQuota: 30 * GIB, maxQuota: 20 * GIB }, 5 * GIB)).toBe(1);
  });
});
