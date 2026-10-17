import { describe, it, expect } from "vitest";
import { brandFromUrl } from "@/lib/config";
import {
  buildEmbedPlan,
  embedMetadata,
  elideMiddle,
  type EmbedContext,
  type EmbedMedia,
} from "@/lib/media/embed";

/**
 * The card a chat client draws is three lines of text (site, title, description)
 * plus a picture. These tests pin the two rules the old implementation broke:
 * the brand is said once, and the file name is said once.
 */

const BRAND = "example";

const CTX: EmbedContext = {
  brand: BRAND,
  appName: "Modlight",
  page: "https://h.example.com/alicja/kalit2.png",
  raw: "https://h.example.com/alicja/kalit2/raw.png",
  oembedHref: "https://h.example.com/oembed?url=x&format=json",
  cardOrigin: "https://h.example.com",
};

function media(over: Partial<EmbedMedia> = {}): EmbedMedia {
  return {
    filename: "screenshot.png",
    ext: "png",
    mimeType: "image/png",
    size: 245_760,
    width: 1920,
    height: 1080,
    kind: "file",
    published: true,
    hasPassword: false,
    hasViewCap: false,
    ...over,
  };
}

/** The three text slots Discord renders, in the order it renders them. */
function cardText(plan: ReturnType<typeof buildEmbedPlan>): string[] {
  if (plan.mode !== "card") throw new Error("expected a card");
  return [plan.og.siteName, plan.og.title, plan.og.description];
}

function occurrences(haystack: string[], needle: string): number {
  return haystack.reduce(
    (n, part) => n + (part.match(new RegExp(needle, "gi"))?.length ?? 0),
    0,
  );
}

describe("brandFromUrl", () => {
  it("collapses every hostname of one deployment to the same word", () => {
    expect(brandFromUrl("https://host.example.com")).toBe("example");
    expect(brandFromUrl("https://h.example.com")).toBe("example");
    expect(brandFromUrl("https://s.example.com")).toBe("example");
    expect(brandFromUrl("https://example.com")).toBe("example");
  });

  it("skips a second-level suffix", () => {
    expect(brandFromUrl("https://files.example.co.uk")).toBe("example");
    expect(brandFromUrl("https://example.com.au")).toBe("example");
  });

  it("drops www and a trailing path/port", () => {
    expect(brandFromUrl("https://www.example.com/files")).toBe("example");
    expect(brandFromUrl("host.example.com:8420/x")).toBe("example");
  });

  it("leaves hosts with nothing to strip alone", () => {
    expect(brandFromUrl("http://localhost:8420")).toBe("localhost");
    expect(brandFromUrl("http://192.168.1.10")).toBe("192.168.1.10");
    expect(brandFromUrl("")).toBe("");
  });
});

describe("embed plan: protected and unlisted files", () => {
  it("says nothing at all about a password-protected file", () => {
    const plan = buildEmbedPlan(media({ hasPassword: true }), CTX);
    expect(plan.mode).toBe("protected");
    // Not even the name: the tab title is visible before anything is unlocked.
    expect(plan.documentTitle).toBe("Modlight");
    expect(plan.documentTitle).not.toContain("screenshot.png");

    const meta = embedMetadata(plan);
    expect(meta.openGraph).toBeUndefined();
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it("keeps an unpublished file out of every index and card", () => {
    const plan = buildEmbedPlan(media({ published: false }), CTX);
    expect(plan.mode).toBe("unlisted");
    expect(plan.documentTitle).toBe("screenshot.png");

    const meta = embedMetadata(plan);
    expect(meta.openGraph).toBeUndefined();
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it("a protected file stays protected whatever its type", () => {
    for (const mimeType of ["image/png", "video/mp4", "text/plain", "application/zip"]) {
      expect(buildEmbedPlan(media({ mimeType, hasPassword: true }), CTX).mode).toBe("protected");
    }
  });
});

describe("embed plan: no repetition", () => {
  it("names the brand once and the file once, for an image", () => {
    const text = cardText(buildEmbedPlan(media(), CTX));
    expect(occurrences(text, BRAND)).toBe(1);
    expect(occurrences(text, "screenshot\\.png")).toBe(1);
  });

  it("names the brand once and the file once, for a zip", () => {
    const text = cardText(
      buildEmbedPlan(
        media({
          filename: "backup-2026-07-31.zip",
          ext: "zip",
          mimeType: "application/zip",
          size: 26_000_000,
          width: null,
          height: null,
        }),
        CTX,
      ),
    );
    expect(occurrences(text, BRAND)).toBe(1);
    expect(occurrences(text, "backup-2026-07-31\\.zip")).toBe(1);
    expect(text[2]).toBe("ZIP archive · 24.8 MB");
  });

  it("never puts the product name in the card", () => {
    const text = cardText(buildEmbedPlan(media(), CTX));
    expect(occurrences(text, "Modlight")).toBe(0);
  });

  it("puts the brand in og:site_name, not in the title", () => {
    const plan = buildEmbedPlan(media(), CTX);
    if (plan.mode !== "card") throw new Error("expected a card");
    expect(plan.og.siteName).toBe(BRAND);
    expect(plan.og.title).toBe("screenshot.png");
    expect(plan.og.description).not.toContain("screenshot");
  });
});

describe("embed plan: descriptions carry facts, not the file name", () => {
  it("image: type, dimensions, size", () => {
    const plan = buildEmbedPlan(media(), CTX);
    if (plan.mode !== "card") throw new Error("expected a card");
    expect(plan.og.description).toBe("PNG · 1920x1080 · 240.0 KB");
    expect(plan.twitterCard).toBe("summary_large_image");
  });

  it("video: same shape, and never a player card", () => {
    const plan = buildEmbedPlan(
      media({
        filename: "clip.mp4",
        ext: "mp4",
        mimeType: "video/mp4",
        size: 13_000_000,
      }),
      CTX,
    );
    if (plan.mode !== "card") throw new Error("expected a card");
    expect(plan.og.type).toBe("video.other");
    expect(plan.og.description).toBe("MP4 · 1920x1080 · 12.4 MB");
    expect(plan.og.video?.url).toBe(CTX.raw);
    // A still URL for a video streams the whole clip back - never emit one.
    expect(plan.og.image).toBeUndefined();
    expect(plan.twitterCard).toBe("summary");
  });

  it("image without stored dimensions falls back to type and size", () => {
    const plan = buildEmbedPlan(media({ width: null, height: null }), CTX);
    if (plan.mode !== "card") throw new Error("expected a card");
    expect(plan.og.description).toBe("PNG · 240.0 KB");
  });

  it("paste: the opening of the text, whitespace collapsed", () => {
    const plan = buildEmbedPlan(
      media({
        filename: "notes.txt",
        ext: "txt",
        mimeType: "text/plain",
        kind: "paste",
        size: 400,
        width: null,
        height: null,
      }),
      { ...CTX, snippet: "  const answer =\n\n\t42;   // computed slowly\n" },
    );
    if (plan.mode !== "card") throw new Error("expected a card");
    expect(plan.og.description).toBe("const answer = 42; // computed slowly");
  });

  it("paste: a long snippet is truncated, not left to be cut by the client", () => {
    const plan = buildEmbedPlan(
      media({ filename: "long.txt", ext: "txt", mimeType: "text/plain", kind: "paste" }),
      { ...CTX, snippet: "a".repeat(500) },
    );
    if (plan.mode !== "card") throw new Error("expected a card");
    expect(plan.og.description.length).toBeLessThanOrEqual(184);
    expect(plan.og.description.endsWith("...")).toBe(true);
  });

  it("text file with nothing readable falls back to type and size", () => {
    const plan = buildEmbedPlan(
      media({
        filename: "huge.log",
        ext: "log",
        mimeType: "text/plain",
        size: 4096,
        width: null,
        height: null,
      }),
      { ...CTX, snippet: "   \n\t  " },
    );
    if (plan.mode !== "card") throw new Error("expected a card");
    expect(plan.og.description).toBe("LOG · 4.0 KB");
  });
});

describe("embed plan: exactly one og:image", () => {
  it("uses the original when it is small enough to show as-is", () => {
    const plan = buildEmbedPlan(media({ width: 900, height: 600 }), CTX);
    if (plan.mode !== "card") throw new Error("expected a card");
    expect(plan.og.image?.url).toBe(CTX.raw);
    expect(plan.og.image?.width).toBe(900);
    expect(plan.og.image?.type).toBe("image/png");
  });

  it("scales an oversized still without cropping it to 1.91:1", () => {
    const plan = buildEmbedPlan(media({ width: 2400, height: 1200 }), CTX);
    if (plan.mode !== "card") throw new Error("expected a card");
    expect(plan.og.image?.url).toBe(`${CTX.raw}?w=1200&fit=inside`);
    expect(plan.og.image?.width).toBe(1200);
    // 2:1 preserved. A 1200x630 crop would have thrown away 30% of the frame.
    expect(plan.og.image?.height).toBe(600);
    expect(plan.og.image?.type).toBe("image/webp");
  });

  it("scales a still too heavy for an unfurler to proxy", () => {
    const plan = buildEmbedPlan(media({ width: 800, height: 600, size: 12 * 1024 * 1024 }), CTX);
    if (plan.mode !== "card") throw new Error("expected a card");
    expect(plan.og.image?.url).toBe(`${CTX.raw}?w=1200&fit=inside`);
  });
});

describe("embed plan: the type card", () => {
  function planFor(over: Partial<EmbedMedia>) {
    const plan = buildEmbedPlan(media({ width: null, height: null, ...over }), CTX);
    if (plan.mode !== "card") throw new Error("expected a card");
    return plan;
  }

  it("gives an archive a large card drawn for its type", () => {
    const plan = planFor({ filename: "backup.zip", ext: "zip", mimeType: "application/zip" });
    expect(plan.og.image?.url).toBe("https://h.example.com/embed/v1/archive-ZIP.png");
    expect(plan.og.image?.width).toBe(1200);
    expect(plan.og.image?.height).toBe(630);
    expect(plan.og.image?.type).toBe("image/png");
    // The spoken equivalent of the glyph.
    expect(plan.og.image?.alt).toBe("ZIP archive");
    // At `summary` Discord files it into an 80x80 tile, where nothing is legible.
    expect(plan.twitterCard).toBe("summary_large_image");
  });

  it("gives a script the web glyph and a paste the text glyph", () => {
    expect(planFor({ filename: "app.ts", ext: "ts", mimeType: "text/plain" }).og.image?.url).toBe(
      "https://h.example.com/embed/v1/code-TS.png",
    );
    expect(
      planFor({ filename: "notes.rs", ext: "rs", mimeType: "text/plain", kind: "paste" }).og.image
        ?.url,
    ).toBe("https://h.example.com/embed/v1/text-RS.png");
  });

  it("leaves a displayable image showing its own bytes", () => {
    const plan = buildEmbedPlan(media(), CTX);
    if (plan.mode !== "card") throw new Error("expected a card");
    // Its own bytes, possibly scaled - never a drawing of a picture.
    expect(plan.og.image?.url.startsWith(CTX.raw)).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("/embed/");
  });

  it("leaves a video with its player and no still at all", () => {
    const plan = planFor({ filename: "clip.mp4", ext: "mp4", mimeType: "video/mp4" });
    expect(plan.og.image).toBeUndefined();
    expect(plan.og.video?.url).toBe(CTX.raw);
    expect(JSON.stringify(plan)).not.toContain("/embed/");
  });

  it("never mentions a card for a protected or unpublished file", () => {
    for (const over of [{ hasPassword: true }, { published: false }]) {
      const zip = media({ ext: "zip", mimeType: "application/zip", ...over });
      const meta = embedMetadata(buildEmbedPlan(zip, CTX));
      expect(JSON.stringify(meta)).not.toContain("/embed/");
    }
  });

  it("does not name the file in the card address", () => {
    // The URL is (category, token) only, so it is neither an enumeration oracle
    // nor a per-upload cache entry.
    const plan = planFor({ filename: "salaries-2026.xlsx", ext: "xlsx", mimeType: "application/vnd.ms-excel" });
    expect(plan.og.image?.url).toBe("https://h.example.com/embed/v1/sheet-XLSX.png");
    expect(plan.og.image?.url).not.toContain("salaries");
    expect(plan.og.image?.url).not.toContain("kalit2");
  });
});

describe("embedMetadata", () => {
  const meta = embedMetadata(buildEmbedPlan(media(), CTX));

  it("emits a single og:image", () => {
    expect(meta.openGraph && "images" in meta.openGraph ? meta.openGraph.images : []).toHaveLength(1);
  });

  it("clears the inherited description rather than leaving it unset", () => {
    // Metadata is inherited from the root layout, so merely omitting this
    // published the product blurb on the page of every single file. null is the
    // only value Next reads as "remove it".
    expect(meta.description).toBeNull();
    expect(meta.applicationName).toBeNull();
    expect(meta.openGraph?.description).toBe("PNG · 1920x1080 · 240.0 KB");
  });

  it("declares the twitter block so Next cannot generate a second one", () => {
    // Next fills twitter:* in from openGraph whether or not this object exists;
    // routing the card through `other` produced a DUPLICATE twitter:card rather
    // than suppressing anything. Declaring it is what yields exactly one.
    expect(meta.other?.["twitter:card"]).toBeUndefined();
    // Next's `Twitter` type is a union whose members disagree about `card`, so
    // the assertion reads the shape we actually pass rather than fighting it.
    const tw = meta.twitter as { card?: string; description?: string } | undefined;
    expect(tw?.card).toBe("summary_large_image");
    // Values mirror Open Graph on purpose - no consumer sees two stories.
    expect(tw?.description).toBe(meta.openGraph?.description);
  });

  it("keeps the canonical URL and the oEmbed discovery link", () => {
    expect(meta.alternates?.canonical).toBe(CTX.page);
    expect(meta.alternates?.types?.["application/json+oembed"]).toBe(CTX.oembedHref);
  });

  it("gives the tab an absolute title so it is not templated into the app name", () => {
    expect(meta.title).toEqual({ absolute: "screenshot.png · example" });
  });
});

/**
 * The machine-readable description of the file, advertised beside oEmbed.
 *
 * This page is HTML at a URL ending in .png, which is the single most misleading
 * thing the deployment serves. oEmbed answers "how do I embed this"; link-info
 * answers "what IS this and where are the bytes", which is the question an
 * automated reader actually has after being handed markup for what looked like
 * an image. Optional, so every existing caller keeps working - and withheld on
 * the pages that were deliberately given an empty head.
 */
describe("link-info discovery", () => {
  const LINK_INFO = "https://h.example.com/api/link-info?url=x";

  it("emits a JSON alternate beside the oEmbed one", () => {
    const meta = embedMetadata(buildEmbedPlan(media(), { ...CTX, linkInfoHref: LINK_INFO }));
    expect(meta.alternates?.types?.["application/json"]).toBe(LINK_INFO);
    // Distinct media types, so a consumer reading only `type` cannot confuse one
    // for the other.
    expect(meta.alternates?.types?.["application/json+oembed"]).toBe(CTX.oembedHref);
  });

  it("emits nothing when no href is supplied", () => {
    const meta = embedMetadata(buildEmbedPlan(media(), CTX));
    expect(meta.alternates?.types?.["application/json"]).toBeUndefined();
  });

  it("stays off a gated or unlisted page, which has no head to add to", () => {
    for (const gate of [{ hasPassword: true }, { published: false }]) {
      const meta = embedMetadata(
        buildEmbedPlan(media(gate), { ...CTX, linkInfoHref: LINK_INFO }),
      );
      expect(meta.alternates).toBeUndefined();
    }
  });
});

describe("elideMiddle", () => {
  it("leaves a normal name alone", () => {
    expect(elideMiddle("screenshot.png", 100)).toBe("screenshot.png");
  });

  it("keeps the extension when it has to shorten", () => {
    const long = `${"a".repeat(200)}.pdf`;
    const out = elideMiddle(long, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out).toContain("...");
  });

  it("copes with a name that is all extension-less noise", () => {
    const out = elideMiddle("b".repeat(300), 40);
    expect(out.length).toBeLessThanOrEqual(40);
  });
});
