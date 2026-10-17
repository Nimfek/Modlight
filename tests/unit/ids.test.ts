import { describe, it, expect } from "vitest";
import { humanCode, userCode, slugify, secureToken } from "@/lib/ids";

describe("ids", () => {
  it("humanCode has the requested length, no dots, ends in digits", () => {
    const c = humanCode(10);
    expect(c).toHaveLength(10);
    expect(c).not.toContain(".");
    expect(/\d{2}$/.test(c)).toBe(true);
  });

  it("humanCode is reasonably unique", () => {
    const set = new Set(Array.from({ length: 500 }, () => humanCode(10)));
    expect(set.size).toBeGreaterThan(495);
  });

  it("userCode has the requested length", () => {
    expect(userCode(6)).toHaveLength(6);
  });

  it("slugify lowercases and dasherizes", () => {
    expect(slugify("Hello World!!")).toBe("hello-world");
    expect(slugify("  a__b  ")).toBe("a-b");
    expect(slugify("Łódź 2024")).toBe("d-2024");
  });

  it("secureToken is url-safe and long", () => {
    const t = secureToken(24);
    expect(t.length).toBeGreaterThanOrEqual(30);
    expect(/^[A-Za-z0-9_-]+$/.test(t)).toBe(true);
  });
});
