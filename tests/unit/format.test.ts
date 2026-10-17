import { describe, it, expect } from "vitest";
import { humanFileSize, relativeTime } from "@/lib/format";

describe("humanFileSize", () => {
  it("formats sizes", () => {
    expect(humanFileSize(0)).toBe("0 B");
    expect(humanFileSize(512)).toBe("512 B");
    expect(humanFileSize(1024)).toBe("1.0 KB");
    expect(humanFileSize(1536, 1)).toBe("1.5 KB");
    expect(humanFileSize(60 * 1024 * 1024)).toBe("60.0 MB");
  });
});

/**
 * Relative time is checked by the WORDS a language uses, never by the exact
 * string ICU emits.
 *
 * "2 hr. ago" versus "2 hours ago" is a CLDR data decision that changes between
 * Node releases; pinning it would make this file fail for a reason that has
 * nothing to do with the code. What must hold is that the reader's language is
 * the one on screen and that the direction of time is right, and "ago" / "temu"
 * / "in" / "za" are stable enough in both dictionaries to assert on.
 */
const HOUR = 3600_000;
const DAY = 86_400_000;

describe("relativeTime", () => {
  it("renders in the locale it is handed, not in English", () => {
    const pl = relativeTime(Date.now() - 2 * HOUR, "pl");
    expect(pl).toContain("2");
    expect(pl).toContain("temu");
    expect(pl).not.toContain("ago");
  });

  it("renders English when English is asked for", () => {
    expect(relativeTime(Date.now() - 2 * HOUR, "en")).toContain("ago");
    expect(relativeTime(Date.now() - 3 * DAY, "en")).toContain("3");
  });

  it("defaults to English rather than to whatever the host is set to", () => {
    // The container's ICU default and the browser's navigator.language are both
    // somebody other than the reader, and disagreeing across the two sides of a
    // render is also a hydration mismatch.
    expect(relativeTime(Date.now() - 2 * HOUR)).toBe(relativeTime(Date.now() - 2 * HOUR, "en"));
  });

  it("picks the largest unit that still counts more than one", () => {
    expect(relativeTime(Date.now() - 90 * DAY, "en")).toContain("3"); // months
    expect(relativeTime(Date.now() - 800 * DAY, "en")).toContain("2"); // years
    expect(relativeTime(Date.now() - 45 * 1000, "en")).not.toContain("45");
    // `numeric: "auto"` is what turns a single step into a word ("last year",
    // "yesterday") rather than counting it. Asserted as "carries no digit"
    // rather than as the exact CLDR wording, which moves between releases.
    expect(relativeTime(Date.now() - 400 * DAY, "en")).not.toMatch(/\d/);
    expect(relativeTime(Date.now(), "en")).not.toMatch(/\d/);
  });

  it("says an instant in the future is in the future", () => {
    // The old implementation subtracted in one direction only, so an expiry a
    // week away rendered as "just now" next to the word "Expires".
    const en = relativeTime(Date.now() + 3 * DAY, "en");
    expect(en).toContain("in");
    expect(en).not.toContain("ago");
    expect(relativeTime(Date.now() + 3 * DAY, "pl")).toContain("za");
  });

  it("rounds a future instant away from zero, like a past one", () => {
    // Math.round(-1.5) is -1: rounding a signed difference bends future times
    // towards the present, which is why magnitude and direction are kept apart.
    expect(relativeTime(Date.now() + 90 * 60_000, "en")).toContain("2");
  });

  it("accepts the three shapes the call sites hold a date in", () => {
    const iso = new Date(Date.now() - 2 * HOUR).toISOString();
    const expected = relativeTime(Date.now() - 2 * HOUR, "en");
    expect(relativeTime(iso, "en")).toBe(expected);
    expect(relativeTime(new Date(iso), "en")).toBe(expected);
  });

  it("renders nothing for an unparseable date", () => {
    // It used to render "NaNy ago" in the middle of a table.
    expect(relativeTime("not a date", "en")).toBe("");
    expect(relativeTime(Number.NaN, "en")).toBe("");
  });

  it("survives a malformed locale, because a cookie can carry one", () => {
    expect(() => relativeTime(Date.now() - 2 * HOUR, "not a locale")).not.toThrow();
    expect(relativeTime(Date.now() - 2 * HOUR, "not a locale")).toContain("ago");
  });
});
