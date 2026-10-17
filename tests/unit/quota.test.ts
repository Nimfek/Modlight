import { describe, it, expect } from "vitest";
import {
  UNLIMITED_QUOTA,
  formatQuotaInput,
  isUnlimited,
  parseQuota,
  quotaRatio,
} from "@/lib/quota";

/**
 * Admins type "20G" into the per-user limit field in Admin → Users, and the
 * value lands in a bigint column where -1 means unlimited. A parser that
 * silently returns 0 on garbage would lock an account out of uploading, so
 * "unparseable" has to be distinguishable from "zero".
 */
describe("parseQuota", () => {
  it("parses the common suffixes as binary multiples", () => {
    expect(parseQuota("1K")).toBe(1024);
    expect(parseQuota("512M")).toBe(512 * 1024 ** 2);
    expect(parseQuota("20G")).toBe(20 * 1024 ** 3);
    expect(parseQuota("1T")).toBe(1024 ** 4);
  });

  it("accepts the long and IEC spellings, case-insensitively", () => {
    expect(parseQuota("512mb")).toBe(512 * 1024 ** 2);
    expect(parseQuota("512MiB")).toBe(512 * 1024 ** 2);
    expect(parseQuota("2 GB")).toBe(2 * 1024 ** 3);
  });

  it("treats a bare number as bytes", () => {
    expect(parseQuota("1024")).toBe(1024);
    expect(parseQuota("0")).toBe(0);
  });

  it("accepts a comma decimal — Polish keyboards produce it", () => {
    expect(parseQuota("1,5G")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseQuota("1.5G")).toBe(Math.round(1.5 * 1024 ** 3));
  });

  it("maps every 'no limit' spelling onto the -1 sentinel", () => {
    for (const v of ["", "  ", "-1", "unlimited", "none", "∞"]) {
      expect(parseQuota(v)).toBe(UNLIMITED_QUOTA);
    }
  });

  it("returns null rather than guessing on junk", () => {
    expect(parseQuota("abc")).toBeNull();
    expect(parseQuota("20 gigs")).toBeNull();
    expect(parseQuota("12X")).toBeNull();
    expect(parseQuota("1e3")).toBeNull();
  });

  it("refuses sizes that stop being exact JS integers", () => {
    // finalize.ts does quota arithmetic in plain numbers; past 2^53 the sums
    // would drift silently.
    expect(parseQuota("9007199254740993")).toBeNull();
    expect(parseQuota("1024P")).toBeNull();
  });
});

describe("formatQuotaInput", () => {
  it("round-trips the values parseQuota produces", () => {
    for (const text of ["1K", "512M", "20G", "1T"]) {
      expect(formatQuotaInput(parseQuota(text)!)).toBe(text);
    }
  });

  it("renders unlimited as an empty field", () => {
    expect(formatQuotaInput(-1)).toBe("");
    expect(formatQuotaInput(null)).toBe("");
  });

  it("falls back to raw bytes when the value is not a round multiple", () => {
    expect(formatQuotaInput(1500)).toBe("1500");
  });
});

describe("isUnlimited / quotaRatio", () => {
  it("treats -1 and NULL as unlimited (NULL predates the column default)", () => {
    expect(isUnlimited(-1)).toBe(true);
    expect(isUnlimited(null)).toBe(true);
    expect(isUnlimited(undefined)).toBe(true);
    expect(isUnlimited(0)).toBe(false);
    expect(isUnlimited(1024)).toBe(false);
  });

  it("has no ratio without a ceiling", () => {
    expect(quotaRatio(1024, -1)).toBeNull();
    expect(quotaRatio(1024, null)).toBeNull();
  });

  it("clamps into 0..1 so an over-quota account cannot overflow the meter", () => {
    expect(quotaRatio(512, 1024)).toBe(0.5);
    expect(quotaRatio(4096, 1024)).toBe(1);
    expect(quotaRatio(0, 1024)).toBe(0);
  });
});
