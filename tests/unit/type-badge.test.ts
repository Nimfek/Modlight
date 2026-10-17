import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEMES } from "@/lib/themes";
import { mimeToIcon } from "@/lib/media/mime";
import { contrast as ratioOf, hexToRgb, over, skinBlock, token } from "@/tests/helpers/skin-colors";
import {
  FAMILY_EMBLEM,
  FAMILY_ICON,
  FAMILY_PLATE,
  canPlayVideo,
  canShowImage,
  hasVisualPreview,
  kindIcon,
  kindTint,
  typeFamily,
  type TypeFamily,
} from "@/components/dashboard/media";

/**
 * The tile's type badge, measured rather than eyeballed.
 *
 * Two things here are load-bearing and neither is visible in a screenshot: the
 * white label has to stay legible on every family plate (which is why the plates
 * are opaque - see FAMILY_PLATE), and every family has to own a plate, a glyph,
 * a tint and a name in BOTH locales, or a file quietly renders a raw key like
 * `type.family.font` in the middle of the grid.
 */

// -- contrast, same maths as tests/unit/skin-contrast.test.ts ----------------

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`not an opaque hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE: [number, number, number] = [255, 255, 255];
/** WCAG AA for body text. The label is small, so this is the right bar. */
const MIN = 4.5;

const FAMILIES = Object.keys(FAMILY_PLATE) as TypeFamily[];

function familyNames(locale: string): Record<string, string> {
  const raw = readFileSync(join(process.cwd(), "messages", locale, "files.json"), "utf8");
  return JSON.parse(raw).type?.family ?? {};
}

/** A MIME type that lands in the given family, for the round-trip checks. */
function plausibleMime(family: TypeFamily): string {
  const byFamily: Record<TypeFamily, string> = {
    image: "image/png",
    video: "video/mp4",
    audio: "audio/mpeg",
    pdf: "application/pdf",
    document: "text/plain",
    data: "text/csv",
    code: "text/html",
    archive: "application/zip",
    font: "font/woff2",
    app: "application/x-msi",
    binary: "application/octet-stream",
  };
  return byFamily[family];
}

describe("type badge plates", () => {
  it("covers every family", () => {
    expect(FAMILIES.length).toBeGreaterThanOrEqual(10);
  });

  for (const family of FAMILIES) {
    it(`keeps the ${family} label readable on its plate`, () => {
      const ratio = contrast(WHITE, rgb(FAMILY_PLATE[family]));
      expect(
        ratio,
        `white on ${FAMILY_PLATE[family]} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(MIN);
    });
  }

  it("gives every family its own colour", () => {
    expect(new Set(Object.values(FAMILY_PLATE)).size).toBe(FAMILIES.length);
  });

  it("is opaque: a translucent plate would inherit the skin behind it", () => {
    for (const value of Object.values(FAMILY_PLATE)) {
      expect(value, value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("type families", () => {
  const cases: [string, string, TypeFamily][] = [
    ["application/pdf", "pdf", "pdf"],
    ["text/html", "html", "code"],
    ["application/json", "json", "code"],
    ["text/x-python", "py", "code"],
    ["application/xhtml+xml", "xhtml", "code"],
    ["application/zip", "zip", "archive"],
    ["application/x-7z-compressed", "7z", "archive"],
    ["text/csv", "csv", "data"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx", "data"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx", "document"],
    ["text/plain", "txt", "document"],
    ["text/markdown", "md", "document"],
    ["application/x-subrip", "srt", "document"],
    ["audio/mpeg", "mp3", "audio"],
    ["video/x-matroska", "mkv", "video"],
    ["image/png", "png", "image"],
    ["font/woff2", "woff2", "font"],
    ["application/vnd.microsoft.portable-executable", "exe", "app"],
    ["application/vnd.android.package-archive", "apk", "app"],
    ["model/stl", "stl", "binary"],
  ];

  for (const [mime, ext, family] of cases) {
    it(`files ${mime} as ${family}`, () => {
      expect(typeFamily(mime, ext)).toBe(family);
    });
  }

  it("reads the extension only when the stored type says nothing", () => {
    // ShareX on Windows sends octet-stream for anything the registry does not
    // know, which is the whole reason effectiveType exists.
    expect(typeFamily("application/octet-stream", "pdf")).toBe("pdf");
    expect(typeFamily("", "zip")).toBe("archive");
    // A stored type that DOES say something wins over a misleading name.
    expect(typeFamily("application/pdf", "zip")).toBe("pdf");
    expect(typeFamily("application/octet-stream", "gr2")).toBe("binary");
    expect(typeFamily(null, null)).toBe("binary");
  });

  it("has a glyph for every family", () => {
    for (const family of FAMILIES) {
      expect(kindIcon("other", plausibleMime(family)), family).toBeTruthy();
    }
  });

  it("keys both icon tables by the same families", () => {
    expect(Object.keys(FAMILY_ICON).sort()).toEqual(FAMILIES.slice().sort());
    expect(Object.keys(FAMILY_EMBLEM).sort()).toEqual(FAMILIES.slice().sort());
    for (const family of FAMILIES) {
      expect(FAMILY_EMBLEM[family], family).toBeTruthy();
    }
  });

  it("never draws a file outline inside the badge's own file outline", () => {
    // The plate is already a sheet of paper. `FileImage` inside it reads as a
    // rendering bug, so the emblem table must not reuse the row-icon table.
    for (const family of FAMILIES) {
      const name = FAMILY_EMBLEM[family].displayName ?? "";
      expect(name, `${family} emblem is ${name}`).not.toMatch(/^File/);
    }
  });
});

describe("family names are translated everywhere", () => {
  for (const locale of ["en", "pl"]) {
    it(`names every family in ${locale}`, () => {
      const dict = familyNames(locale);
      const missing = FAMILIES.filter((f) => !dict[f]);
      const extra = Object.keys(dict).filter((k) => !FAMILIES.includes(k as TypeFamily));
      expect({ missing, extra }, locale).toEqual({ missing: [], extra: [] });
    });
  }
});

describe("what the tile can actually draw", () => {
  it("refuses images the thumbnailer cannot open", () => {
    expect(canShowImage("image/png", "png")).toBe(true);
    expect(canShowImage("image/avif", "avif")).toBe(true);
    // Passes `isImage`, gets no thumbnail: this is the row that used to render
    // an empty grey rectangle.
    expect(canShowImage("image/heic", "heic")).toBe(false);
    expect(canShowImage("image/vnd.adobe.photoshop", "psd")).toBe(false);
    expect(canShowImage("image/svg+xml", "svg")).toBe(false);
  });

  it("refuses containers no browser can demux", () => {
    expect(canPlayVideo("video/mp4", "mp4")).toBe(true);
    expect(canPlayVideo("video/quicktime", "mov")).toBe(true);
    expect(canPlayVideo("video/x-matroska", "mkv")).toBe(false);
    expect(canPlayVideo("video/x-msvideo", "avi")).toBe(false);
  });

  it("is the union of the two, so the badge fills exactly the gap", () => {
    const samples = [
      ["image/png", "png"],
      ["image/heic", "heic"],
      ["video/mp4", "mp4"],
      ["video/x-matroska", "mkv"],
      ["application/pdf", "pdf"],
      ["application/octet-stream", "gr2"],
    ] as const;
    for (const [mime, ext] of samples) {
      expect(hasVisualPreview(mime, ext), `${mime}/${ext}`).toBe(
        canShowImage(mime, ext) || canPlayVideo(mime, ext),
      );
    }
  });
});

describe("one colour per file, everywhere it appears", () => {
  it("uses the same family axis for the row tint as for the badge", () => {
    // A PDF and a README are both FileKind "document"; their tints must not be.
    expect(kindTint("document", "application/pdf")).not.toBe(kindTint("document", "text/plain"));
    expect(kindTint("application/pdf")).toBe(kindTint("document", "application/pdf"));
  });

  it("keeps a paste looking like a paste", () => {
    expect(kindTint("paste")).toContain("emerald");
    expect(kindTint("paste", "text/x-python")).toContain("emerald");
  });

  it("falls back to tokens when there is nothing to say about the file", () => {
    expect(kindTint("application/octet-stream")).toContain("bg-muted");
  });
});

describe("the tile never asks for bytes it cannot draw", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "dashboard", "FileCard.tsx"),
    "utf8",
  );

  it("branches on what renders, not on what the MIME family claims", () => {
    // `isImage`/`isVideo` are true for HEIC and Matroska, which is exactly how
    // the wall of blank tiles happened. They must not come back here.
    expect(source).not.toMatch(/\bisImage\(/);
    expect(source).not.toMatch(/\bisVideo\(/);
    expect(source).toMatch(/\bcanShowImage\(/);
    expect(source).toMatch(/\bcanPlayVideo\(/);
  });

  it("lays nothing but the motion chip over a preview that did render", () => {
    const preview = source.slice(source.indexOf("{/* Preview"), source.indexOf("{/* Meta"));
    // The badge appears twice: as the no-preview branch, and as the thumbnail's
    // failure fallback. Never as an overlay on a picture that rendered.
    expect(preview.match(/typeBadge/g)?.length).toBe(2);
    expect(preview).toContain("<TypeChip");
  });
});

/**
 * The one part of the mark that must know about the skin.
 *
 * The plate is opaque so the white label on it is a constant (measured above),
 * but opacity is also what lets the sheet SHAPE vanish: a dark plate on a dark
 * tile is white text floating in a rectangle, not a file. The rim is therefore
 * drawn in `currentColor` off a foreground token, so it inverts with the skin.
 * This measures the result on every skin in both modes rather than trusting it.
 */
describe("the mark keeps its shape on every skin", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "dashboard", "Thumbnail.tsx"),
    "utf8",
  );

  /** The rim as the component actually draws it, read back out of the source. */
  function rim(): { alpha: number } {
    expect(source, "the rim must follow the skin, not a fixed colour").toContain(
      'stroke="currentColor"',
    );
    const cls = source.match(/text-foreground\/(\d{1,3})/);
    expect(cls, "the badge svg must set its currentColor from a foreground token").toBeTruthy();
    return { alpha: Number(cls![1]) / 100 };
  }

  it("draws the rim from a token rather than a fixed white", () => {
    expect(rim().alpha).toBeGreaterThan(0);
    // A white rim is invisible on a light skin, which is how this started.
    expect(source).not.toMatch(/stroke="#(fff|ffffff)"/i);
  });

  /**
   * 3:1 - WCAG 1.4.11, the bar for a graphic that carries meaning. Not the 4.5:1
   * asked of text: the extension printed ON the plate is the text, and it is
   * measured against the plate in the block above.
   */
  const MIN_SHAPE = 3;

  it("keeps every plate distinguishable from the tile under it", () => {
    const { alpha } = rim();
    const failures: string[] = [];
    let checked = 0;

    for (const theme of THEMES) {
      const block = skinBlock(theme.id);
      expect(block.length, `no variable block for ${theme.id}`).toBeGreaterThan(200);

      for (const mode of ["l", "d"] as const) {
        const card = token(block, `${mode}-card`);
        const muted = token(block, `${mode}-muted`);
        const fg = token(block, `${mode}-foreground`);
        if (!card || !fg) continue;

        // The two surfaces a badge is ever drawn on: the tile's preview area
        // (`bg-muted/40` over the card) and the Thumbnail's own `bg-muted`,
        // which is where the badge lands when a thumbnail fails to load.
        const surfaces: [string, [number, number, number]][] = [
          ["tile", muted ? over(muted, card, 0.4) : card],
          ["failed thumbnail", muted ?? card],
        ];

        for (const [where, surface] of surfaces) {
          for (const family of FAMILIES) {
            const edge = over(fg, hexToRgb(FAMILY_PLATE[family]), alpha);
            const r = ratioOf(edge, surface);
            checked++;
            if (r < MIN_SHAPE) {
              failures.push(`${theme.id}/${mode} ${family} on ${where}: ${r.toFixed(2)}:1`);
            }
          }
        }
      }
    }

    // win98 is authored in hex and the rest in OKLCH; a parser that silently
    // read neither would otherwise pass by measuring nothing.
    expect(checked, "no skin surfaces could be read").toBeGreaterThan(200);
    expect(failures, failures.join("; ")).toEqual([]);
  });
});

/**
 * The viewer's icon, which answers the same question as the badge from a second
 * place: `mimeToIcon` is in lib (server-reachable, so it can hold no React), the
 * family axis is in components (it names lucide components). They cannot share
 * code as things stand, so they are at least held to the same answers here.
 */
describe("the viewer icon agrees with the tile", () => {
  it("does not call a disk image a photograph", () => {
    // `includes("image")` was the first rule in the map, and a .dmg is a disk
    // full of software.
    expect(mimeToIcon("application/x-apple-diskimage", "dmg")).not.toBe("FileImage");
    expect(mimeToIcon("image/png", "png")).toBe("FileImage");
  });

  it("does not call a slide deck a photograph", () => {
    for (const m of [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
      "application/vnd.oasis.opendocument.presentation",
    ]) {
      expect(mimeToIcon(m), m).not.toBe("FileImage");
      // The row icons file a deck under "document"; the two must not disagree.
      expect(typeFamily(m), m).toBe("document");
    }
  });

  it("does not reduce a zip-container document to an archive", () => {
    expect(mimeToIcon("application/epub+zip", "epub")).toBe("FileText");
    expect(
      mimeToIcon("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
    ).toBe("FileText");
    // A real archive still is one.
    expect(mimeToIcon("application/zip", "zip")).toBe("FileArchive");
  });

  it("still reads the extension when the stored type says nothing", () => {
    expect(mimeToIcon("application/octet-stream", "mp4")).toBe("FileVideo");
    expect(mimeToIcon("application/octet-stream", "gr2")).toBe("File");
  });
});
