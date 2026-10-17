/**
 * Reading the skins' real colours out of app/globals.css, and the WCAG maths
 * for comparing them.
 *
 * Extracted so a second test does not have to grow a second copy of the colour
 * pipeline. tests/unit/skin-contrast.test.ts still carries its own (it is not
 * this task's file to edit); adopting this module there would remove the
 * duplicate, and the numbers must agree because the algorithms are the ones
 * WCAG and the CSS spec define, not choices.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Rgb = [number, number, number];

const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

/** OKLCH (the syntax nearly every skin is authored in) to sRGB 0-255. */
export function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
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
  }) as Rgb;
}

export function hexToRgb(value: string): Rgb {
  const m = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!m) throw new Error(`not an opaque hex colour: ${value}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function relativeLuminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` painted at `alpha` over `bg`, which is what a token like `/35` does. */
export function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha))) as Rgb;
}

/**
 * The variable block a skin declares. Only the FIRST block per skin: the later
 * ones live in media queries and deliberately override a handful of values.
 */
export function skinBlock(id: string): string {
  const selector = id === "default" ? '[data-theme="default"],' : `[data-theme="${id}"] {`;
  const at = css.indexOf(selector);
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  const close = css.indexOf("\n}", open);
  return css.slice(open, close);
}

/**
 * Read one token as a flat colour, or null when it is absent or unreadable.
 *
 * Both syntaxes are handled on purpose: most skins are authored in OKLCH, but
 * win98 is authored in hex because its whole point is a set of exact 1998 system
 * colours. A parser that only spoke OKLCH would silently check nothing at all
 * for that skin, so callers must also assert that they checked something.
 *
 * An alpha component is DROPPED rather than refused: the glass skin's surfaces
 * are translucent over a wallpaper nobody can know, and its base tone is still
 * the most honest stand-in available for that surface. Callers comparing
 * against a surface should treat the result as indicative for that skin.
 */
export function token(block: string, name: string, opts: { alpha?: "drop" | "reject" } = {}): Rgb | null {
  const line = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!line) return null;
  const value = line[1].trim();

  if (/^#[0-9a-fA-F]{6}$/.test(value)) return hexToRgb(value);

  const ok = value.match(/^oklch\(([^)]+)\)$/);
  if (!ok) return null;
  if (ok[1].includes("/") && opts.alpha === "reject") return null;

  const parts = ok[1].split("/")[0].trim().split(/[\s,]+/);
  const [L, C, H] = [parts[0], parts[1] ?? "0", parts[2] ?? "0"].map(Number);
  if ([L, C, H].some((v) => !Number.isFinite(v))) return null;
  return oklchToRgb(L, C, H);
}
