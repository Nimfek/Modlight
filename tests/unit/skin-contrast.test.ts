import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEMES } from "@/lib/themes";

/**
 * Every skin, in both modes, must keep its text legible on its own surfaces.
 *
 * Round 6 measured this by hand once and the numbers were fine; a measurement
 * taken once protects nothing, because the next skin is added by someone who
 * never saw it. This reads the real stylesheet, so a skin that ships an
 * unreadable pairing fails here rather than in front of a user.
 *
 * Only the pairings that actually carry reading matter are checked: body text on
 * the page, card text on a card, and the label on a primary button. Borders,
 * charts and decorative surfaces are deliberately out of scope - they are not
 * text, and holding them to a text ratio would only teach people to raise the
 * threshold until it stopped meaning anything.
 */

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

/** OKLCH (the only colour syntax these skins use) to sRGB 0-255. */
function oklchToRgb(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const bb = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.291485548 * bb;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  return lin.map((v) => {
    const clamped = Math.min(1, Math.max(0, v));
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  }) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The variable block a skin declares. Only the FIRST block per skin: the later
 *  ones live in media queries and deliberately override a handful of values. */
function skinBlock(id: string): string {
  const selector = id === "default" ? '[data-theme="default"],' : `[data-theme="${id}"] {`;
  const at = css.indexOf(selector);
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  return css.slice(open, close);
}

/**
 * Read one token, or null when it is absent or not a plain opaque colour.
 *
 * Both syntaxes are handled on purpose: most skins are authored in OKLCH, but
 * win98 is authored in hex because its whole point is a set of exact 1998 system
 * colours. A parser that only spoke OKLCH would silently check nothing at all
 * for that skin - which is why the caller also asserts it checked something.
 */
function token(block: string, name: string): [number, number, number] | null {
  const line = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!line) return null;
  const value = line[1].trim();

  const hex = value.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  const ok = value.match(/^oklch\(([^)]+)\)$/);
  if (!ok) return null;
  // A slash means alpha - such a value composites over something else, so a flat
  // ratio against it would be a fiction.
  if (ok[1].includes("/")) return null;
  const parts = ok[1].trim().split(/[\s,]+/);
  const [L, C, H] = [parts[0], parts[1] ?? "0", parts[2] ?? "0"].map(Number);
  if ([L, C, H].some((v) => !Number.isFinite(v))) return null;
  return oklchToRgb(L, C, H);
}

/**
 * 4.5:1 is the WCAG AA bar for body text. Deliberately not the 11:1 that Round 6
 * happened to measure: a threshold set at whatever the current values reach is a
 * threshold that fails the next honest design decision rather than a real
 * accessibility floor.
 */
const MIN = 4.5;

describe("skin contrast", () => {
  const pairs = [
    ["foreground", "background", "tekst na tle"],
    ["card-foreground", "card", "tekst na karcie"],
    ["primary-foreground", "primary", "napis na przycisku"],
    ["sidebar-foreground", "sidebar", "tekst w panelu bocznym"],
  ] as const;

  for (const theme of THEMES) {
    const block = skinBlock(theme.id);

    it(`${theme.id} stays readable in both modes`, () => {
      expect(block.length, `no variable block found for ${theme.id}`).toBeGreaterThan(200);

      const failures: string[] = [];
      let checked = 0;

      for (const mode of ["l", "d"] as const) {
        for (const [fgName, bgName, label] of pairs) {
          const fg = token(block, `${mode}-${fgName}`);
          const bg = token(block, `${mode}-${bgName}`);
          if (!fg || !bg) continue;
          checked++;
          const ratio = contrast(fg, bg);
          if (ratio < MIN) {
            failures.push(`${mode === "l" ? "jasny" : "ciemny"} / ${label}: ${ratio.toFixed(2)}:1`);
          }
        }
      }

      // A skin whose tokens could not be read would otherwise pass by checking
      // nothing at all.
      expect(checked, `no readable token pairs for ${theme.id}`).toBeGreaterThanOrEqual(4);
      expect(failures, `${theme.id}: ${failures.join(", ")}`).toEqual([]);
    });
  }
});
