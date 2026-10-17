/**
 * Rasterise a file-type card.
 *
 * Split from the route so the same bytes can be produced by a script, and split
 * from card-art.ts so that module stays free of sharp and can be asserted in a
 * plain unit test.
 *
 * The one word on the card goes through sharp's own text renderer with an
 * EXPLICIT font file rather than through the SVG, because the production image
 * ships no fontconfig and no system font: `<text>` there renders as empty boxes
 * at the wrong size. Pointing pango at a file sidesteps fontconfig entirely.
 * The alternative (planting a fonts.conf and setting FONTCONFIG_FILE) works too
 * but is global process state that has to be set before anything imports sharp,
 * so it would fail silently on a warm server. This fails locally and loudly.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  cardPath,
  isCardToken,
  type CardChoice,
} from "@/lib/media/card";
import {
  cardArt,
  TOKEN_CENTER_Y,
  TOKEN_FONT_SIZE,
  TOKEN_MAX_WIDTH,
} from "@/lib/media/card-art";

/**
 * Shipped in the repo rather than resolved out of node_modules: the font lives
 * under a pnpm content hash that changes with every dependency edit, while
 * `public/` is copied into the image verbatim. It is already served to browsers
 * by next/font, so nothing new is exposed.
 */
const FONT_FILE = path.join(process.cwd(), "public", "fonts", "Geist-Bold.ttf");

/** Checked once: a missing font must cost one stat call, not one per request. */
const FONT_AVAILABLE = existsSync(FONT_FILE);

/**
 * A card is fully determined by (category, token), and lib/media/card.ts admits
 * only pairs this app can actually emit - one per known extension plus eight
 * fallbacks. That closed set is what makes an unevicted map safe here: the
 * ceiling is the extension table, not the caller's imagination.
 *
 * Promises rather than buffers, so N simultaneous first hits on a cold card
 * share ONE sharp run. Storing only after the await let every concurrent
 * request start its own render, multiplying the cost of a cold cache by the
 * number of connections.
 */
const CACHE = new Map<string, Promise<Buffer>>();

export function renderCard(choice: CardChoice): Promise<Buffer> {
  const key = cardPath(choice);
  const hit = CACHE.get(key);
  if (hit) return hit;

  const pending = drawCard(choice).catch((err) => {
    // A failed draw must not be cached, or one transient fault poisons this
    // card for the life of the process.
    CACHE.delete(key);
    throw err;
  });
  CACHE.set(key, pending);
  return pending;
}

async function drawCard(choice: CardChoice): Promise<Buffer> {
  const { svg, accent } = cardArt(choice.category);
  const base = sharp(Buffer.from(svg));

  const label = await drawToken(choice.token, accent);
  if (label) {
    base.composite([
      {
        input: label.png,
        left: Math.round((CARD_WIDTH - label.width) / 2),
        top: Math.round(TOKEN_CENTER_Y - label.height / 2),
      },
    ]);
  }

  return base.png({ compressionLevel: 9 }).toBuffer();
}

interface Token {
  png: Buffer;
  width: number;
  height: number;
}

/**
 * The token, or null when it cannot be drawn.
 *
 * Null is a real outcome, not an error path: without the font the card still
 * has its glyph, its plate and its colour, and og:title still spells the file
 * out in full. A card that 500s would cost the embed entirely.
 */
async function drawToken(token: string, colour: string): Promise<Token | null> {
  if (!FONT_AVAILABLE || !isCardToken(token)) return null;

  try {
    let rendered = await renderText(token, colour, TOKEN_FONT_SIZE);
    // Long words ("DOCUMENT") would run past the safe area, so measure and
    // shrink rather than guess a size per word.
    if (rendered.width > TOKEN_MAX_WIDTH) {
      const scaled = Math.max(
        24,
        Math.floor((TOKEN_FONT_SIZE * TOKEN_MAX_WIDTH) / rendered.width),
      );
      rendered = await renderText(token, colour, scaled);
    }
    return rendered;
  } catch {
    return null;
  }
}

async function renderText(token: string, colour: string, size: number): Promise<Token> {
  const png = await sharp({
    text: {
      // Pango markup, so the colour and the tracking travel with the text.
      // `token` is [A-Z0-9] only, so there is nothing here to escape.
      text: `<span foreground="${colour}" letter_spacing="6144">${token}</span>`,
      font: `Geist ${size}px`,
      fontfile: FONT_FILE,
      rgba: true,
    },
  })
    .png()
    .toBuffer();

  const meta = await sharp(png).metadata();
  return { png, width: meta.width ?? 0, height: meta.height ?? 0 };
}

export const CARD_DIMENSIONS = { width: CARD_WIDTH, height: CARD_HEIGHT };
