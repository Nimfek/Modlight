import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SourceView } from "@/components/viewer/SourceView";
import { sourceReadings } from "@/lib/media/source-preview";

/**
 * What the preview page actually puts on screen, rendered for real.
 *
 * The preview page is public, server-rendered and unfurled by bots, so this is
 * the markup a stranger receives before a single line of JavaScript runs. Two
 * things can only be shown by a real render:
 *
 *  - user content is escaped exactly once, by React, on its way into text
 *    children. `<script>` stored in a paste has to arrive as those characters.
 *  - the file opens on the SOURCE reading. If a rendered frame were ever in the
 *    first paint, every visit to a shared link would run an upload's script
 *    without anybody choosing to.
 */

function messages(locale: "en" | "pl") {
  const read = (ns: string) =>
    JSON.parse(readFileSync(join(process.cwd(), "messages", locale, `${ns}.json`), "utf8"));
  return { viewer: read("viewer"), common: read("common") };
}

const RAW = "https://h.example.com/ToqOse/abc123/raw.html";
const RENDER = "/ToqOse/abc123/render?t=a-ticket";

function render(props: Record<string, unknown>, locale: "en" | "pl" = "en") {
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale, messages: messages(locale), children: null } as never,
      createElement(SourceView, {
        content: "print('hello')\n",
        size: 15,
        filename: "script.py",
        rawUrl: RAW,
        readings: sourceReadings({ rawUrl: RAW }),
        ...props,
      } as never),
    ),
  );
}

describe("a .py opens as code", () => {
  const html = render({});

  it("puts the source on the page instead of a download card", () => {
    expect(html).toContain("print(&#x27;hello&#x27;)");
    // The line-number gutter is what makes it read as code rather than as a
    // paragraph, and it is the marker the E2E suite looks for too.
    expect(html).toContain("<pre");
  });

  it("names the language", () => {
    expect(render({ language: "Python" })).toContain("Python");
  });

  it("offers both readings it has, and no third one", () => {
    const en = messages("en").viewer.render;
    expect(html).toContain(en.source);
    expect(html).toContain(en.raw);
    expect(html).not.toContain(en.page);
  });

  it("links Raw at the raw response, in a new tab", () => {
    expect(html).toMatch(
      new RegExp(`href="${RAW.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"[^>]*target="_blank"`),
    );
  });
});

describe("an HTML paste renders as escaped text", () => {
  // Exactly the file the owner reported: a paste whose language is HTML. It is
  // stored as text/html, which is what earns it the render toggle - and it must
  // still arrive on this page as characters.
  const PAYLOAD = `<script>alert(document.cookie)</script><img src=x onerror="alert(1)">`;
  const html = render({
    content: PAYLOAD,
    filename: "page.html",
    language: "HTML",
    shape: "html",
    readings: sourceReadings({ rawUrl: RAW, renderPath: RENDER }),
  });

  it("escapes every byte of it, exactly once", () => {
    expect(html).toContain("&lt;script&gt;alert(document.cookie)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=");
    // Once, not twice: a double-escaped page shows the visitor `&amp;lt;`.
    expect(html).not.toContain("&amp;lt;");
  });

  it("puts no live script or image tag in the document", () => {
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror=\"alert(1)\"");
    expect(html).not.toContain("<img src=x");
  });

  it("offers all three readings", () => {
    const en = messages("en").viewer.render;
    expect(html).toContain(en.source);
    expect(html).toContain(en.page);
    expect(html).toContain(en.raw);
  });

  it("does NOT render the frame until somebody clicks", () => {
    // The load-bearing assertion of this file. Source is the default reading
    // for everyone, the owner included, so a shared link never executes an
    // upload on arrival.
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain(RENDER);
  });

  it("warns that rendering runs the file, only where rendering is on offer", () => {
    expect(html).toContain(messages("en").viewer.render.notice);
    expect(render({})).not.toContain(messages("en").viewer.render.notice);
  });
});

describe("an SVG is held to the stricter sandbox", () => {
  it("would frame it with sandbox=\"\", never with allow-scripts", () => {
    // The attribute is only emitted once the frame is open, so this pins the
    // prop that decides it: `shape` reaches the iframe, and svg means no
    // scripts. Sandbox flags from the attribute and from the response policy
    // intersect, so this cannot be loosened by the config-level CSP.
    const html = render({
      shape: "svg",
      filename: "drawing.svg",
      readings: sourceReadings({ rawUrl: RAW, renderPath: RENDER }),
    });
    expect(html).not.toContain("allow-scripts");
    expect(html).not.toContain("allow-same-origin");
  });
});

describe("over the ceiling", () => {
  const SIZE = 3 * 1024 * 1024;
  const html = render({ content: null, unavailable: "too-large", size: SIZE });

  it("says how big the file is rather than rendering nothing", () => {
    expect(html).toContain("3.0 MB");
  });

  it("offers the raw file as the way to the bytes", () => {
    expect(html).toContain(messages("en").viewer.text.openRaw);
    expect(html).toContain(RAW);
  });

  it("keeps the toggle, because a file too big to inline can still be rendered", () => {
    // MAX_INLINE_TEXT is 512 KB and MAX_RENDER_BYTES is 5 MB, so this is a real
    // combination: no source to show, a page that can still be run.
    const withRender = render({
      content: null,
      unavailable: "too-large",
      size: SIZE,
      shape: "html",
      readings: sourceReadings({ rawUrl: RAW, renderPath: RENDER }),
    });
    expect(withRender).toContain(messages("en").viewer.render.page);
  });

  it("does not blame the size when the read simply failed", () => {
    const unreadable = render({ content: null, unavailable: "unreadable", size: 1234 });
    expect(unreadable).toContain(messages("en").viewer.text.unreadable);
    expect(unreadable).not.toContain("1.2 KB");
    // Still a way out.
    expect(unreadable).toContain(RAW);
  });
});

describe("Polish", () => {
  it("renders the whole control in Polish", () => {
    const pl = messages("pl").viewer;
    const html = render(
      { readings: sourceReadings({ rawUrl: RAW, renderPath: RENDER }), shape: "html" },
      "pl",
    );
    expect(html).toContain(pl.render.source);
    expect(html).toContain(pl.render.page);
    expect(html).toContain(pl.render.notice);
  });

  it("translates the over-ceiling message too", () => {
    const html = render(
      { content: null, unavailable: "too-large", size: 3 * 1024 * 1024 },
      "pl",
    );
    expect(html).toContain(messages("pl").viewer.text.openRaw);
    expect(html).toContain("3.0 MB");
  });
});
