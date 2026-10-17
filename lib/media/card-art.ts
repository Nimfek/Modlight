/**
 * The drawing on a file-type card: one family, eight glyphs.
 *
 * Two constraints shaped every decision here.
 *
 * The first is that the production container has no fontconfig and not one
 * system font, so librsvg draws `<text>` as empty boxes and ignores font-size
 * (an embedded @font-face does not help - librsvg ignores webfonts). Everything
 * in this module is therefore pure geometry; the one word on the card is drawn
 * separately by sharp's own text renderer with an explicit font file, and
 * composited on top. Nothing here may ever grow a <text> element.
 *
 * The second is that the card is looked at OUTSIDE our site, in someone else's
 * chat window, so it inherits no theme and no language. What keeps eight cards
 * reading as one family is that only the hue changes: lightness and chroma of
 * the accent are pinned (L=0.80, C<=0.13), which holds every card at the same
 * visual weight and between 9.4:1 and 10.4:1 of contrast against the backdrop.
 */

import { CARD_HEIGHT, CARD_WIDTH, type CardCategory } from "@/lib/media/card";

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** OKLCH to linear sRGB. */
function oklchToLinearRgb(L: number, C: number, hueDeg: number): [number, number, number] {
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const encodeGamma = (u: number) =>
  u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/**
 * Largest chroma at this lightness/hue that still fits sRGB, capped.
 *
 * Without the walk, orange and green at C=0.13 clip differently and the family
 * loses the equal weight that is the entire point of pinning L.
 */
function fitChroma(L: number, hue: number, cap: number): number {
  let c = cap;
  while (c > 0 && !inGamut(oklchToLinearRgb(L, c, hue))) c -= 0.002;
  return Math.max(0, c);
}

function hex(L: number, C: number, hue: number): string {
  const rgb = oklchToLinearRgb(L, C, hue).map((v) =>
    Math.round(Math.min(1, Math.max(0, encodeGamma(v))) * 255),
  );
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const ACCENT_L = 0.8;
const ACCENT_C_CAP = 0.13;

/** Hue 277 is the default skin's --primary, so the card is related to the product. */
const NEUTRAL_HUE = 277;

const BG = hex(0.19, 0.015, NEUTRAL_HUE);
const BG_EDGE = hex(0.145, 0.012, NEUTRAL_HUE);

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

interface CardStyle {
  hue: number;
  /** Fallback art is deliberately grey: "I do not know what this is" should not shout. */
  neutral?: boolean;
  /** Drawn in a 180x180 box; `CHIP` is substituted with the plate stroke colour. */
  glyph: string;
}

const STYLES: Record<CardCategory, CardStyle> = {
  code: {
    hue: 195,
    glyph: `<path d="M70 45 L25 90 L70 135"/><path d="M110 45 L155 90 L110 135"/><path d="M100 30 L80 150"/>`,
  },
  archive: {
    // The latch is what separates a crate from a plain box at thumbnail size.
    hue: 45,
    glyph: `<rect x="15" y="35" width="150" height="120" rx="16"/><path d="M15 75 H165"/><rect x="76" y="55" width="28" height="40" rx="10" fill="CHIP"/>`,
  },
  document: {
    hue: 277,
    glyph: `<path d="M35 15 H105 L145 55 V165 H35 Z"/><path d="M105 15 V55 H145"/><path d="M60 100 H120"/><path d="M60 130 H100"/>`,
  },
  sheet: {
    hue: 150,
    glyph: `<path d="M15 41 h150 v29 h-150 z" fill="CHIP" stroke="none"/><rect x="15" y="25" width="150" height="130" rx="16"/><path d="M15 70 H165"/><path d="M15 112 H165"/><path d="M78 70 V155"/>`,
  },
  audio: {
    // A symmetric level meter, not a quaver: five bars survive being 17px tall,
    // a note's stem and flag collapse into a smudge.
    hue: 320,
    glyph: `<path d="M25 70 V110"/><path d="M62 40 V140"/><path d="M99 20 V160"/><path d="M136 45 V135"/><path d="M170 75 V105"/>`,
  },
  text: {
    // The caret is the only difference from `document`, and it is what says
    // "characters" rather than "file".
    hue: 230,
    glyph: `<path d="M20 45 H150"/><path d="M20 85 H160"/><path d="M20 125 H105"/><path d="M135 108 V150"/>`,
  },
  image: {
    hue: 15,
    glyph: `<rect x="15" y="30" width="150" height="120" rx="16"/><circle cx="60" cy="70" r="13"/><path d="M28 143 L72 99 L101 128 L128 101 L163 136"/>`,
  },
  binary: {
    hue: NEUTRAL_HUE,
    neutral: true,
    glyph: `<rect x="35" y="35" width="110" height="110" rx="18"/><path d="M70 15 V35 M110 15 V35 M70 145 V165 M110 145 V165 M15 70 H35 M15 110 H35 M145 70 H165 M145 110 H165"/>`,
  },
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const PLATE = 320;
const PLATE_X = (CARD_WIDTH - PLATE) / 2;
const PLATE_Y = 105;
const PLATE_RADIUS = 72;

/** The glyph fills 220 of the plate's 320, leaving 50 of air on every side. */
const GLYPH_BOX = 220;
const GLYPH_SCALE = GLYPH_BOX / 180;
const GLYPH_X = PLATE_X + (PLATE - GLYPH_BOX) / 2;
const GLYPH_Y = PLATE_Y + (PLATE - GLYPH_BOX) / 2;

/**
 * Vertical middle of the token, not its top: the label is measured after it is
 * drawn (sharp returns a tight ink box), and shrinking a long word must not also
 * float it upwards.
 */
export const TOKEN_CENTER_Y = 497;

/** Nominal token size; a long word is scaled down to fit TOKEN_MAX_WIDTH. */
export const TOKEN_FONT_SIZE = 78;
export const TOKEN_MAX_WIDTH = 560;

export interface CardArt {
  svg: string;
  /** Token colour, as a hex string pango markup can take. */
  accent: string;
}

/** The whole card except its one word: background, plate and glyph. */
export function cardArt(category: CardCategory): CardArt {
  const style = STYLES[category];
  const chroma = style.neutral ? 0.015 : fitChroma(ACCENT_L, style.hue, ACCENT_C_CAP);
  const accent = hex(ACCENT_L, chroma, style.hue);
  const plateFill = hex(0.28, style.neutral ? 0.01 : Math.min(chroma, 0.05), style.hue);
  const plateStroke = hex(0.42, style.neutral ? 0.012 : Math.min(chroma, 0.07), style.hue);
  const glow = hex(0.32, style.neutral ? 0.012 : Math.min(chroma, 0.07), style.hue);
  const glyph = style.glyph.replaceAll("CHIP", plateStroke);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
<defs>
  <radialGradient id="glow" cx="50%" cy="42%" r="52%">
    <stop offset="0%" stop-color="${glow}" stop-opacity="0.55"/>
    <stop offset="100%" stop-color="${BG_EDGE}" stop-opacity="0"/>
  </radialGradient>
</defs>
<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG_EDGE}"/>
<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}" opacity="0.85"/>
<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow)"/>
<rect x="${PLATE_X}" y="${PLATE_Y}" width="${PLATE}" height="${PLATE}" rx="${PLATE_RADIUS}" fill="${plateFill}" stroke="${plateStroke}" stroke-width="3.5"/>
<g transform="translate(${GLYPH_X} ${GLYPH_Y}) scale(${GLYPH_SCALE})" fill="none" stroke="${accent}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
</svg>`;

  return { svg, accent };
}
