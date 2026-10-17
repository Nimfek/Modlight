/**
 * Render the brand mark that transactional emails carry, and write it to
 * public/brand/email-logo.png.
 *
 * A committed PNG, for the same reason as scripts/make-audio-cover.ts: it is
 * the same picture in every message, so rasterising it per send would put
 * librsvg on a path that has no variable in it.
 *
 * PNG rather than the SVG we already have, because mail clients decide this for
 * us: Gmail, Outlook desktop and Outlook.com do not render SVG in a message
 * body at all. 128x128 for a mark displayed at 40x40, so it stays sharp on the
 * 2x and 3x screens most mail is read on.
 *
 * Run with: pnpm tsx scripts/make-email-logo.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharpModule from "sharp";

const SIZE = 128;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0.55" y2="1">
      <stop offset="0" stop-color="#6E6BF5"/>
      <stop offset="1" stop-color="#3B2FC2"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="7" fill="url(#tile)"/>
  <rect width="32" height="32" rx="7" fill="url(#gloss)"/>
  <path d="M16 5.4 L25.6 15.6 L19.6 15.6 L16 11.0 L12.4 15.6 L6.4 15.6 Z"
        fill="#fff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
  <rect x="9.2" y="18.8" width="13.6" height="3.4" rx="1.7" fill="#fff"/>
  <rect x="12.4" y="24" width="7.2" height="3.4" rx="1.7" fill="#fff" opacity="0.85"/>
</svg>`;

const out = path.join(process.cwd(), "public", "brand", "email-logo.png");
await mkdir(path.dirname(out), { recursive: true });

const png = await sharpModule(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

await writeFile(out, png);
console.log(`${out} (${png.length} bytes)`);
