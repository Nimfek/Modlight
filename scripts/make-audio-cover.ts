/**
 * Render the still picture that "download this audio as MP4" plays behind the
 * sound, and write it to public/brand/audio-cover.png.
 *
 * A committed PNG rather than something built at request time, for two reasons.
 * It is the same picture for every file and every user, so rendering it per
 * request would be work with no variable in it; and rasterising SVG at runtime
 * means librsvg on the request path, which is a decoder this app deliberately
 * keeps away from anything hot (lib/media/convert-targets.ts explains why we do
 * not even convert uploaded SVG).
 *
 * The mark is app/icon.svg at 3x, on the flat black the user asked for. 1280x720
 * with even dimensions, which is what yuv420p needs and what every player and
 * every social embed expects of a video.
 *
 * Run with: pnpm tsx scripts/make-audio-cover.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharpModule from "sharp";

const WIDTH = 1280;
const HEIGHT = 720;
/** The tile, in pixels. Roughly a third of the short side: visible, not shouty. */
const MARK = 240;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
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
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#000000"/>
  <g transform="translate(${(WIDTH - MARK) / 2} ${(HEIGHT - MARK) / 2}) scale(${MARK / 32})">
    <rect width="32" height="32" rx="7" fill="url(#tile)"/>
    <rect width="32" height="32" rx="7" fill="url(#gloss)"/>
    <path d="M16 5.4 L25.6 15.6 L19.6 15.6 L16 11.0 L12.4 15.6 L6.4 15.6 Z"
          fill="#fff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
    <rect x="9.2" y="18.8" width="13.6" height="3.4" rx="1.7" fill="#fff"/>
    <rect x="12.4" y="24" width="7.2" height="3.4" rx="1.7" fill="#fff" opacity="0.85"/>
  </g>
</svg>`;

const out = path.join(process.cwd(), "public", "brand", "audio-cover.png");
await mkdir(path.dirname(out), { recursive: true });

const png = await sharpModule(Buffer.from(svg))
  .png({ compressionLevel: 9, palette: false })
  .toBuffer();

await writeFile(out, png);
console.log(`${out} (${png.length} bytes)`);
