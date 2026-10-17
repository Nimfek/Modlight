import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which stage the viewer picks for a file - the decision itself, not the
 * classification behind it.
 *
 * tests/unit/source-preview.test.ts proves `showsSource` answers correctly for
 * a .py and a .json. That is worth nothing if the viewer asks a different
 * question, and for a while it did: the preview page read the bytes of a .json
 * off disk using `showsSource`, and the viewer then drew a download card
 * because its own condition was `kind === "text" || shape` - and `mediaKind`
 * calls application/json "other". The read happened and was thrown away.
 *
 * So this renders the real component and looks at what came out.
 */

// The server-side halves of next-intl need a request scope. The viewer only
// uses them for labels, so echoing the key is enough to tell the stages apart.
vi.mock("next-intl/server", () => ({
  getTranslations: async (ns?: string) => (key: string) => `${ns ?? ""}.${key}`,
  getFormatter: async () => ({ number: (n: number) => String(n) }),
  // The viewer stamps its "uploaded ..." line through Intl, which has to be
  // told the reader's language; the stage is what this file measures, so the
  // locale only has to exist.
  getLocale: async () => "en",
}));

const { MediaViewer } = await import("@/components/viewer/MediaViewer");

function messages() {
  const read = (ns: string) =>
    JSON.parse(readFileSync(join(process.cwd(), "messages", "en", `${ns}.json`), "utf8"));
  return { viewer: read("viewer"), common: read("common") };
}

const BASE = {
  filename: "script.py",
  mimeType: "text/x-python",
  ext: "py",
  size: 512,
  views: 1,
  downloads: 0,
  createdAt: new Date("2026-08-18T10:00:00Z"),
  publicUrl: "https://h.example.com/ToqOse/abc123.py",
  rawUrl: "https://h.example.com/ToqOse/abc123/raw.py",
  downloadUrl: "https://h.example.com/ToqOse/abc123/download",
  textContent: "import os\nprint(os.getcwd())\n",
};

async function stage(props: Record<string, unknown> = {}): Promise<string> {
  const element = (await MediaViewer({ ...BASE, ...props } as never)) as ReactElement;
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale: "en", messages: messages(), children: null } as never,
      element,
    ),
  );
}

/**
 * The download card is the stage that says "no inline preview" and offers the
 * raw link instead of the contents. The label comes from the mocked translator,
 * so it is the key rather than the sentence.
 */
function isDownloadCard(html: string): boolean {
  return html.includes("viewer.noInlinePreview");
}

describe("code lands on the source stage, never on a download card", () => {
  it("shows a .py as code", async () => {
    const html = await stage();
    expect(html).toContain("print(os.getcwd())");
    expect(html).toContain("Python");
    expect(isDownloadCard(html)).toBe(false);
  });

  it("shows the types mediaKind calls 'other' but /raw serves as text", async () => {
    // The exact regression: every one of these has kind "other" and no sandbox
    // shape, so the old condition sent all of them to the download card.
    for (const [mimeType, ext, language] of [
      ["application/json", "json", "JSON"],
      ["application/json", "sxcu", "JSON"],
      ["application/x-sh", "sh", "Shell"],
      ["application/sql", "sql", "SQL"],
      ["application/xml", "xml", "XML"],
      ["image/svg+xml", "svg", "SVG"],
    ] as const) {
      const html = await stage({
        mimeType,
        ext,
        filename: `file.${ext}`,
        textContent: "SOURCE-MARKER",
      });
      expect(html, `${ext} content`).toContain("SOURCE-MARKER");
      expect(html, `${ext} language`).toContain(language);
      expect(isDownloadCard(html), `${ext} card`).toBe(false);
    }
  });

  it("offers Raw beside the source for every one of them", async () => {
    const en = messages().viewer.render;
    const html = await stage({ mimeType: "application/json", ext: "json", filename: "a.json" });
    expect(html).toContain(en.source);
    expect(html).toContain(en.raw);
    expect(html).toContain(BASE.rawUrl.replace("raw.py", "raw.py"));
  });

  it("adds the rendered reading only for markup, and only with a ticket", async () => {
    const en = messages().viewer.render;
    const withTicket = await stage({
      mimeType: "text/html",
      ext: "html",
      filename: "page.html",
      textContent: "<h1>hi</h1>",
      renderPath: "/ToqOse/abc123/render?t=a-ticket",
    });
    expect(withTicket).toContain(en.page);
    // Source still opens first, so no frame is in the first paint.
    expect(withTicket).not.toContain("<iframe");
    expect(withTicket).toContain("&lt;h1&gt;hi&lt;/h1&gt;");

    const noTicket = await stage({
      mimeType: "text/html",
      ext: "html",
      filename: "page.html",
      textContent: "<h1>hi</h1>",
    });
    expect(noTicket).not.toContain(en.page);
    expect(noTicket).toContain(en.raw);
  });
});

describe("everything else keeps the stage it had", () => {
  it("leaves a genuinely unknown binary on the download card", async () => {
    const html = await stage({
      mimeType: "application/octet-stream",
      ext: "gr2",
      filename: "model.gr2",
      textContent: null,
    });
    expect(isDownloadCard(html)).toBe(true);
  });

  it("leaves an archive on the download card", async () => {
    const html = await stage({
      mimeType: "application/zip",
      ext: "zip",
      filename: "bundle.zip",
      textContent: null,
    });
    expect(isDownloadCard(html)).toBe(true);
  });

  it("still gives an image the image stage", async () => {
    const html = await stage({
      mimeType: "image/png",
      ext: "png",
      filename: "shot.png",
      textContent: null,
      width: 800,
      height: 600,
    });
    expect(isDownloadCard(html)).toBe(false);
    expect(html).toContain("<img");
  });

  it("still gives a video the player", async () => {
    const html = await stage({
      mimeType: "video/mp4",
      ext: "mp4",
      filename: "clip.mp4",
      textContent: null,
    });
    expect(html).toContain("<media-controller");
  });

  it("hands the video player the preview track and the poster the page built", async () => {
    // The whole path from the page to the element, because every hop between
    // them is a place a prop silently becomes undefined - `frames` in
    // particular names a global, so leaving it off a prop list compiles and
    // hands the player a Window object.
    const html = await stage({
      mimeType: "video/mp4",
      ext: "mp4",
      filename: "clip.mp4",
      textContent: null,
      frames: 300,
      timelineTrack: "/ToqOse/abc123/timeline.vtt",
      posterUrl: "/ToqOse/abc123/raw?w=800",
    });
    expect(html).toContain('poster="/ToqOse/abc123/raw?w=800"');
    expect(html).toMatch(/<track[^>]*\slabel="thumbnails"/);
    expect(html).toMatch(/<track[^>]*\ssrc="\/ToqOse\/abc123\/timeline\.vtt"/);
  });

  it("gives neither to a file that cannot have one", async () => {
    // A short clip, an oversized one, or anything that is not a video at all:
    // the page passes null and the markup carries nothing to fetch.
    const html = await stage({
      mimeType: "video/mp4",
      ext: "mp4",
      filename: "clip.mp4",
      textContent: null,
    });
    expect(html).not.toContain("<track");
    expect(html).not.toMatch(/\sposter=/);
  });
});

describe("over the ceiling, on the real stage", () => {
  it("names the size and offers raw instead of an empty box", async () => {
    const html = await stage({
      size: 3 * 1024 * 1024,
      textContent: null,
      textUnavailable: "too-large",
    });
    expect(html).toContain("3.0 MB");
    expect(html).toContain(messages().viewer.text.openRaw);
    expect(html).toContain(BASE.rawUrl);
  });
});
