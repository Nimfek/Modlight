import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Full key parity between the locales.
 *
 * The project rule has always been that messages/{en,pl} carry the same keys,
 * but nothing checked it, so the only way a gap showed up was a user meeting a
 * raw key like `viewer.document.legacyDoc` in the middle of a sentence. This is
 * the cheapest possible enforcement: it needs no runtime, no rendering, and it
 * fails on the commit that introduces the gap rather than in production.
 */

const ROOT = join(process.cwd(), "messages");
const LOCALES = readdirSync(ROOT).filter((name) => !name.includes("."));

/** Every leaf path in a message tree, as dotted keys. */
function leaves(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

function load(locale: string, ns: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, locale, ns), "utf8"));
}

describe("translation files", () => {
  it("has more than one locale to compare", () => {
    expect(LOCALES.length).toBeGreaterThan(1);
    expect(LOCALES).toContain("en");
    expect(LOCALES).toContain("pl");
  });

  it("defines the same namespaces in every locale", () => {
    const reference = readdirSync(join(ROOT, "en")).sort();
    for (const locale of LOCALES) {
      expect(readdirSync(join(ROOT, locale)).sort(), locale).toEqual(reference);
    }
  });

  for (const ns of readdirSync(join(ROOT, "en")).sort()) {
    it(`defines the same keys in ${ns} for every locale`, () => {
      const reference = leaves(load("en", ns)).sort();
      for (const locale of LOCALES) {
        if (locale === "en") continue;
        const actual = leaves(load(locale, ns)).sort();
        const missing = reference.filter((k) => !actual.includes(k));
        const extra = actual.filter((k) => !reference.includes(k));
        expect({ missing, extra }, `${locale}/${ns}`).toEqual({ missing: [], extra: [] });
      }
    });
  }

  it("never leaves a value empty, which renders as a blank label", () => {
    for (const locale of LOCALES) {
      for (const ns of readdirSync(join(ROOT, locale))) {
        const stack: [string, unknown][] = [["", load(locale, ns)]];
        while (stack.length) {
          const [path, value] = stack.pop()!;
          if (typeof value === "string") {
            expect(value.trim(), `${locale}/${ns} ${path}`).not.toBe("");
          } else if (value && typeof value === "object") {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
              stack.push([path ? `${path}.${k}` : k, v]);
            }
          }
        }
      }
    }
  });

  it("uses the same interpolation placeholders in every locale", () => {
    // A translation that drops `{filename}` silently renders a sentence with a
    // hole in it, and one that invents `{name}` throws at render time.
    //
    // Only TOP-LEVEL arguments are compared, which is why this is a scanner and
    // not a regex. In ICU a plural's branches are themselves brace-delimited,
    // so `{count, plural, one {file} other {# files}}` contains `{file}` - and
    // its Polish translation legitimately contains `{plik}`, `{# pliki}` and
    // two more. Those are wording, not arguments, and a naive `\{(\w+)[,}]`
    // reports every one of them as a placeholder mismatch.
    const placeholders = (s: string): string[] => {
      const found: string[] = [];
      let depth = 0;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "}") {
          depth--;
          continue;
        }
        if (s[i] !== "{") continue;
        if (depth++ > 0) continue; // inside a branch body: wording, not an argument
        const end = s.slice(i + 1).search(/[,}]/);
        if (end > 0) found.push(s.slice(i + 1, i + 1 + end).trim());
      }
      return found.sort();
    };

    for (const ns of readdirSync(join(ROOT, "en"))) {
      const en = load("en", ns) as Record<string, unknown>;
      for (const locale of LOCALES) {
        if (locale === "en") continue;
        const other = load(locale, ns) as Record<string, unknown>;
        const stack: [string, unknown, unknown][] = [["", en, other]];
        while (stack.length) {
          const [path, a, b] = stack.pop()!;
          if (typeof a === "string" && typeof b === "string") {
            expect(placeholders(b), `${locale}/${ns} ${path}`).toEqual(placeholders(a));
          } else if (a && b && typeof a === "object" && typeof b === "object") {
            for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
              stack.push([path ? `${path}.${k}` : k, v, (b as Record<string, unknown>)[k]]);
            }
          }
        }
      }
    }
  });
});
