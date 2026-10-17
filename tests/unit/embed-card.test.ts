import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CARD_CATEGORIES,
  EMBED_CARD_VERSION,
  cardChoiceFor,
  cardPath,
  cardUrl,
  isCardToken,
  parseCardFile,
  tokenFor,
  type CardSubject,
} from "@/lib/media/card";
import { cardArt } from "@/lib/media/card-art";

/**
 * The card exists to say one thing a chat client cannot say in text: what kind
 * of file this is. These tests pin the three properties that make it safe to
 * serve from a URL with no authentication and a one-year cache.
 */

function subject(over: Partial<CardSubject> = {}): CardSubject {
  return { ext: "zip", mimeType: "application/zip", kind: "file", ...over };
}

describe("card category: extension wins, then MIME, then a neutral fallback", () => {
  const cases: [string, string, string][] = [
    // ext, mime, expected category
    ["zip", "application/zip", "archive"],
    ["rar", "application/x-rar-compressed", "archive"],
    ["7z", "application/x-7z-compressed", "archive"],
    ["apk", "application/vnd.android.package-archive", "archive"],
    ["html", "text/html", "code"],
    ["php", "application/octet-stream", "code"],
    ["js", "application/javascript", "code"],
    ["json", "application/json", "code"],
    ["pdf", "application/pdf", "document"],
    ["docx", "application/octet-stream", "document"],
    ["epub", "application/epub+zip", "document"],
    ["xlsx", "application/octet-stream", "sheet"],
    ["csv", "text/csv", "sheet"],
    ["mp3", "audio/mpeg", "audio"],
    ["flac", "audio/flac", "audio"],
    ["txt", "text/plain", "text"],
    ["log", "text/plain", "text"],
    ["svg", "image/svg+xml", "image"],
    ["psd", "application/octet-stream", "image"],
    ["heic", "image/heic", "image"],
    ["exe", "application/x-msdownload", "binary"],
    ["ttf", "font/ttf", "binary"],
  ];

  for (const [ext, mimeType, expected] of cases) {
    it(`${ext} is ${expected}`, () => {
      expect(cardChoiceFor(subject({ ext, mimeType }))?.category).toBe(expected);
    });
  }

  it("falls back to the neutral card for an extension nobody has heard of", () => {
    // The token is the category word, NOT "QQZ". Echoing an unknown extension
    // would make the set of card URLs unbounded, and the render route is public
    // and unauthenticated: every distinct URL is one sharp run and one cache
    // entry that never expires.
    const choice = cardChoiceFor(subject({ ext: "qqz", mimeType: "application/octet-stream" }));
    expect(choice).toEqual({ category: "binary", token: "FILE" });
  });

  it("reads the MIME when there is no extension at all", () => {
    expect(cardChoiceFor(subject({ ext: "", mimeType: "audio/x-aiff" }))).toEqual({
      category: "audio",
      token: "AUDIO",
    });
    expect(cardChoiceFor(subject({ ext: "", mimeType: "text/x-diff" }))).toEqual({
      category: "text",
      token: "TEXT",
    });
    expect(cardChoiceFor(subject({ ext: "", mimeType: "application/octet-stream" }))).toEqual({
      category: "binary",
      token: "FILE",
    });
  });

  it("treats a paste as text whatever language it was written in", () => {
    expect(cardChoiceFor(subject({ ext: "rs", mimeType: "text/plain", kind: "paste" }))).toEqual({
      category: "text",
      token: "RS",
    });
  });
});

describe("card category: media that already shows itself gets none", () => {
  for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) {
    it(`no card for ${mimeType}`, () => {
      expect(cardChoiceFor(subject({ ext: "png", mimeType }))).toBeNull();
    });
  }

  for (const mimeType of ["video/mp4", "video/webm", "video/x-matroska", "video/quicktime"]) {
    it(`no card for ${mimeType}`, () => {
      expect(cardChoiceFor(subject({ ext: "mp4", mimeType }))).toBeNull();
    });
  }
});

describe("card tokens stay inside a closed alphabet", () => {
  it("keeps letters and digits for extensions it knows", () => {
    expect(tokenFor("zip", "archive")).toBe("ZIP");
    expect(tokenFor("7z", "archive")).toBe("7Z");
  });

  it("refuses to echo an extension it does not know", () => {
    // "tar.gz" is not a key in the table (the extension is "gz"), so it takes
    // the category word rather than minting the URL /embed/v1/archive-TARGZ.png
    // that nothing would ever legitimately request.
    expect(tokenFor("tar.gz", "archive")).toBe("ARCHIVE");
    expect(tokenFor("qqz", "binary")).toBe("FILE");
  });

  it("uses the category word when the extension is unusable", () => {
    // The reason the alphabet is closed: Geist covers no CJK, no Cyrillic and no
    // emoji, and a file may be named anything at all. A token that could contain
    // an arbitrary character would render as empty boxes.
    expect(tokenFor("", "document")).toBe("DOCUMENT");
    expect(tokenFor("日本語", "text")).toBe("TEXT");
    expect(tokenFor("!!!", "binary")).toBe("FILE");
  });

  it("truncates rather than overflowing the card", () => {
    expect(tokenFor("averylongextension", "binary").length).toBeLessThanOrEqual(8);
  });

  it("every fallback word is drawable", () => {
    for (const category of CARD_CATEGORIES) {
      expect(isCardToken(tokenFor("", category))).toBe(true);
    }
  });
});

describe("card address", () => {
  it("names a category and a token, never a file", () => {
    const choice = { category: "archive" as const, token: "ZIP" };
    expect(cardPath(choice)).toBe("/embed/v1/archive-ZIP.png");
    expect(cardUrl("https://h.example.com/", choice)).toBe("https://h.example.com/embed/v1/archive-ZIP.png");
  });

  it("round-trips every category", () => {
    for (const category of CARD_CATEGORIES) {
      const choice = { category, token: tokenFor("", category) };
      const file = cardPath(choice).split("/").pop()!;
      expect(parseCardFile(file)).toEqual(choice);
    }
  });

  it("refuses anything the closed lists do not admit", () => {
    for (const bad of [
      "archive.png",
      "archive-.png",
      "archive-zip.png", // lower case is not the alphabet we draw
      "unknown-ZIP.png",
      "archive-TOOLONGTOKEN.png",
      "archive-ZIP.svg",
      "../../etc/passwd",
      "archive-ZIP.png/../x",
      "ARCHIVE-ZIP.png",
    ]) {
      expect(parseCardFile(bad)).toBeNull();
    }
  });
});

describe("card art", () => {
  it("draws every category", () => {
    for (const category of CARD_CATEGORIES) {
      const { svg, accent } = cardArt(category);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain('viewBox="0 0 1200 630"');
      expect(accent).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("contains no text and no font reference", () => {
    // The production image has no fontconfig and no system font, so librsvg
    // renders <text> as empty boxes at the wrong size. The one word on a card is
    // composited by sharp with an explicit font file instead.
    for (const category of CARD_CATEGORIES) {
      const { svg } = cardArt(category);
      expect(svg).not.toContain("<text");
      expect(svg).not.toContain("<tspan");
      expect(svg).not.toContain("@font-face");
      expect(svg).not.toContain("font-family");
    }
  });

  it("loads nothing from anywhere else", () => {
    // An unfurler fetches this over the open internet; a card that pulled in a
    // remote asset would either leak a request or render half-drawn.
    for (const category of CARD_CATEGORIES) {
      const { svg } = cardArt(category);
      expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
      expect(svg).not.toContain("<image");
      expect(svg).not.toContain("xlink:href");
    }
  });

  it("holds the family together: one lightness, eight hues", () => {
    // Every accent is minted at OKLCH L=0.80 with chroma capped, which is the
    // mechanism that makes eight different cards read as one set: measured
    // against the backdrop they land within a single point of contrast of each
    // other, so none of them shouts louder than the rest.
    const backdrop = relativeLuminance("#12131b");
    const ratios = CARD_CATEGORIES.map(
      (c) => (relativeLuminance(cardArt(c).accent) + 0.05) / (backdrop + 0.05),
    );
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(1.5);
    // ...and all of them clear WCAG AA for body text twice over.
    expect(Math.min(...ratios)).toBeGreaterThan(9);
  });

  it("gives each category its own accent", () => {
    const accents = CARD_CATEGORIES.map((c) => cardArt(c).accent);
    expect(new Set(accents).size).toBe(CARD_CATEGORIES.length);
  });
});

describe("the card route cannot touch a file", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "embed", "[version]", "[card]", "route.ts"),
    "utf8",
  );

  it("imports neither the database nor the media server", () => {
    // Structural, not a flag: with no row in reach, a preview fetch cannot spend
    // a burn-after-view budget and cannot report whether a code exists.
    expect(source).not.toMatch(/from "@\/lib\/db/);
    expect(source).not.toMatch(/from "@\/lib\/media\/serve"/);
    expect(source).not.toContain("consumeView");
    expect(source).not.toContain("getMedia");
  });

  it("freezes the bytes for a year, because the version lives in the path", () => {
    expect(source).toContain("max-age=31536000, immutable");
    expect(EMBED_CARD_VERSION).toBe("v1");
  });
});

function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

describe("the render route only admits pairs this app can emit", () => {
  // The regression this guards: the file name matched /^([a-z]+)-([A-Z0-9]{1,8})\.png$/
  // and nothing else, so 8 categories x 36^8 tokens were all valid URLs on a
  // public unauthenticated route. Each drew a PNG through sharp and kept it in
  // a map with no eviction - unbounded memory and unbounded CPU for anyone
  // willing to send requests.
  it("accepts a real pair", () => {
    expect(parseCardFile("archive-ZIP.png")).toEqual({ category: "archive", token: "ZIP" });
    expect(parseCardFile("binary-FILE.png")).toEqual({ category: "binary", token: "FILE" });
  });

  it("rejects a token no file could have produced", () => {
    expect(parseCardFile("archive-AAAAAAAA.png")).toBeNull();
    expect(parseCardFile("binary-Q7X2K9.png")).toBeNull();
  });

  it("rejects a real token under the wrong category", () => {
    // ZIP is a known extension, but it belongs to `archive`. Admitting it under
    // every category would multiply the cache by the number of categories.
    expect(parseCardFile("code-ZIP.png")).toBeNull();
    expect(parseCardFile("sheet-HTML.png")).toBeNull();
  });

  it("keeps every token a real file can emit renderable", () => {
    // Whatever tokenFor() produces must survive the round trip, or a real file
    // would advertise an og:image that 404s.
    const samples: Array<[string, string]> = [
      ["zip", "archive"], ["7z", "archive"], ["html", "code"], ["php", "code"],
      ["pdf", "document"], ["xlsx", "sheet"], ["flac", "audio"], ["md", "text"],
      ["svg", "image"], ["exe", "binary"], ["qqz", "binary"], ["", "document"],
    ];
    for (const [ext, category] of samples) {
      const token = tokenFor(ext, category as never);
      expect(parseCardFile(`${category}-${token}.png`), `${ext} -> ${category}-${token}`).not.toBeNull();
    }
  });
});
