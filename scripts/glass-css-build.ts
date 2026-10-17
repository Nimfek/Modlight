/**
 * Compiles app/globals.css the way Next does (Tailwind v4 via PostCSS) so the
 * material can be inspected without booting the dev server.
 *
 * Pass --lens to neutralise the `prefers-reduced-transparency: reduce` block:
 * this machine's Chromium reports `reduce` (Windows "Transparency effects" is
 * off), so without it every screenshot silently shows the opaque fallback.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const postcss = (
  await import(
    pathToFileURL(resolve("node_modules/.pnpm/postcss@8.5.15/node_modules/postcss/lib/postcss.mjs")).href
  )
).default;
const tailwind = (await import("@tailwindcss/postcss")).default;

const args = process.argv.slice(2);
const lens = args.includes("--lens");
const to = resolve(args.find((a) => !a.startsWith("--")) || "data/shots/globals.compiled.css");
const from = resolve("app/globals.css");

let css = await readFile(from, "utf8");
if (lens) css = css.replace("prefers-reduced-transparency: reduce", "prefers-reduced-transparency: never");

const result = await postcss([tailwind()]).process(css, { from, to });
await writeFile(to, result.css, "utf8");
console.log("compiled", result.css.length, "bytes", lens ? "(lens forced on)" : "", "->", to);
