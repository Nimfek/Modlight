import { describe, it, expect } from "vitest";
import {
  MAX_INLINE_TEXT,
  codeLanguageLabel,
  inlineTextPlan,
  showsSource,
  sourceReadings,
} from "@/lib/media/source-preview";
import { pasteMimeType, rowMimeType } from "@/lib/media/paste-type";
import { mediaKind, serveDecision } from "@/lib/media/mime";
import { sandboxShape } from "@/lib/media/render-ticket";
import { resolveUploadType } from "@/lib/media/sniff";
import { LANG_EXT } from "@/lib/paste-languages";

/**
 * "If I upload a .py I want to see the code, not a download card."
 *
 * The subject here is one question - does this file read as source - and the
 * rule that it must have exactly ONE answer. The preview page uses it to decide
 * whether to spend a read; the viewer uses it to decide what to draw. When those
 * two were written down separately they disagreed, and the shape of the
 * disagreement was always the same: the page read half a megabyte off disk and
 * then drew a download card for a file whose "Open raw" button showed the very
 * same bytes as text.
 */

/** What `resolveUploadType` would store for a text file with this extension. */
function storedTypeOf(ext: string, clientMime = "application/octet-stream"): string {
  return resolveUploadType({
    head: Buffer.from("const x = 1;\nprint('hello')\n", "utf8"),
    ext,
    clientMime,
  });
}

describe("code opens as code", () => {
  // The report's own example first, then the rest of the family. Every one of
  // these goes through the real upload typing path rather than a hand-written
  // MIME, so the test fails if sniffing ever stops recognising them.
  const CODE = ["py", "js", "ts", "tsx", "json", "sh", "css", "md", "yml", "toml", "sql", "xml", "c"];

  for (const ext of CODE) {
    it(`shows the source of a .${ext} upload`, () => {
      const mimeType = storedTypeOf(ext);
      expect(showsSource({ mimeType, ext }), `${ext} -> ${mimeType}`).toBe(true);
    });
  }

  it("covers the types mediaKind alone called 'other', which is the bug", () => {
    // These are the exact rows that used to get a download card: /raw streams
    // them inline as text/plain, but none of them is text/* and none is
    // renderable markup, so the old `kind === "text" || shape` condition missed
    // every one. A ShareX .sxcu is in the list because this app generates them.
    for (const ext of ["json", "sh", "sql", "xml", "sxcu", "svg"]) {
      const mimeType = storedTypeOf(ext);
      expect(mediaKind(mimeType, ext), `${ext} kind`).toBe("other");
      expect(showsSource({ mimeType, ext }), `${ext} source`).toBe(true);
    }
  });

  it("survives a client that says application/octet-stream", () => {
    // ShareX on Windows reads the type out of the registry, which has no entry
    // for most of these. The extension is the only evidence left.
    const mimeType = "application/octet-stream";
    expect(showsSource({ mimeType, ext: "py" })).toBe(true);
    expect(showsSource({ mimeType, ext: "" })).toBe(false);
  });

  it("does not claim binaries, media or documents read as source", () => {
    for (const [mimeType, ext] of [
      ["image/png", "png"],
      ["video/mp4", "mp4"],
      ["audio/mpeg", "mp3"],
      ["application/pdf", "pdf"],
      ["application/zip", "zip"],
      ["application/octet-stream", "gr2"],
      [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
      ],
    ] as const) {
      expect(showsSource({ mimeType, ext }), `${ext}`).toBe(false);
    }
  });
});

describe("a paste behaves as a paste", () => {
  it("gives every language a type its own preview layer can read", () => {
    for (const language of Object.keys(LANG_EXT)) {
      const stored = pasteMimeType(language) ?? "text/plain; charset=utf-8";
      const row = { kind: "paste", language, mimeType: stored, ext: LANG_EXT[language] };
      expect(showsSource(row), language).toBe(true);
    }
  });

  it("declares an HTML paste as HTML, which is what earns it the render toggle", () => {
    expect(pasteMimeType("html")).toBe("text/html");
    const row = { kind: "paste", language: "html", mimeType: "text/html", ext: "html" };
    expect(sandboxShape(rowMimeType(row), row.ext)).toBe("html");
  });

  it("repairs a paste created before the type was honest, with no migration", () => {
    // Rows written by the old `createPaste` carry the placeholder type but the
    // right language, so the language is what gets read.
    const legacy = { kind: "paste", language: "html", mimeType: "text/plain; charset=utf-8" };
    expect(rowMimeType(legacy)).toBe("text/html");
    expect(rowMimeType({ ...legacy, kind: "file" })).toBe("text/plain; charset=utf-8");
  });

  it("NEVER lets a paste name a type that /raw would serve with its own header", () => {
    // The whole safety argument for storing a paste as text/html rests on this:
    // whatever the author picks, the bytes still leave the server inert.
    for (const language of Object.keys(LANG_EXT)) {
      const stored = pasteMimeType(language);
      if (stored === null) continue;
      const decision = serveDecision(stored, LANG_EXT[language]);
      expect(decision.disposition, language).toBe("inline");
      expect(decision.contentType, language).toBe("text/plain; charset=utf-8");
    }
  });

  it("refuses a language whose name collides with a non-text extension", () => {
    // LANG_EXT.ts is "ts" and the extension table reads `ts` as an MPEG
    // transport stream. Trusting it would turn a TypeScript paste into a video
    // row with a dead player - on the likeliest language this app ever sees.
    expect(pasteMimeType("ts")).toBeNull();
    const row = { kind: "paste", language: "ts", mimeType: "text/plain; charset=utf-8", ext: "ts" };
    expect(mediaKind(rowMimeType(row), row.ext)).toBe("text");
    expect(showsSource(row)).toBe(true);
  });

  it("says nothing for a language it has no type for", () => {
    expect(pasteMimeType("klingon")).toBeNull();
    expect(pasteMimeType("")).toBeNull();
    expect(pasteMimeType(null)).toBeNull();
  });
});

describe("the readings a preview offers", () => {
  const rawUrl = "https://h.example.com/ToqOse/abc123/raw.html";
  const renderPath = "/ToqOse/abc123/render?t=ticket";

  it("offers source and raw for ordinary code, and nothing else", () => {
    const readings = sourceReadings({ rawUrl });
    expect(readings.map((r) => r.mode)).toEqual(["source", "raw"]);
    expect(readings.find((r) => r.mode === "source")?.href).toBeNull();
    expect(readings.find((r) => r.mode === "raw")?.href).toBe(rawUrl);
  });

  it("adds the rendered reading for markup, with the ticketed URL", () => {
    const readings = sourceReadings({ rawUrl, renderPath });
    // Order is part of the contract: the two readings that swap in place sit
    // together and the one that leaves the page is last.
    expect(readings.map((r) => r.mode)).toEqual(["source", "page", "raw"]);
    expect(readings.find((r) => r.mode === "page")?.href).toBe(renderPath);
    expect(readings.find((r) => r.mode === "raw")?.href).toBe(rawUrl);
  });

  it("never points a reading at the wrong file", () => {
    // The bug a rendering test is worst at catching: two buttons, one file.
    for (const reading of sourceReadings({ rawUrl, renderPath })) {
      if (reading.href) expect(reading.href, reading.mode).toContain("abc123");
    }
  });

  it("drops the rendered reading when rendering is refused", () => {
    expect(sourceReadings({ rawUrl, renderPath: null }).map((r) => r.mode)).toEqual([
      "source",
      "raw",
    ]);
  });
});

describe("the size ceiling", () => {
  it("reads up to the ceiling and refuses past it", () => {
    expect(inlineTextPlan(0)).toBe("read");
    expect(inlineTextPlan(MAX_INLINE_TEXT)).toBe("read");
    expect(inlineTextPlan(MAX_INLINE_TEXT + 1)).toBe("too-large");
  });

  it("keeps the ceiling somewhere a public page can afford", () => {
    // It travels in the server-rendered payload of a link anyone can open.
    expect(MAX_INLINE_TEXT).toBe(512 * 1024);
  });
});

describe("naming the language on screen", () => {
  it("names an upload by its extension", () => {
    expect(codeLanguageLabel({ mimeType: "text/x-python", ext: "py" })).toBe("Python");
    expect(codeLanguageLabel({ mimeType: "text/plain", ext: "ts" })).toBe("TypeScript");
    expect(codeLanguageLabel({ mimeType: "application/json", ext: "sxcu" })).toBe("JSON");
  });

  it("names a paste by the language its author chose", () => {
    expect(
      codeLanguageLabel({ kind: "paste", language: "html", mimeType: "text/html", ext: "html" }),
    ).toBe("HTML");
    expect(
      codeLanguageLabel({ kind: "paste", language: "cpp", mimeType: "text/x-c", ext: "cpp" }),
    ).toBe("C++");
  });

  it("echoes an unknown extension only when it is short and tame", () => {
    expect(codeLanguageLabel({ mimeType: "text/plain", ext: "zzz" })).toBe("ZZZ");
    // A filename is somebody else's string. React escapes it either way, but a
    // chip is not the place for forty characters of punctuation.
    expect(codeLanguageLabel({ mimeType: "text/plain", ext: "a-very-long-extension" })).toBeNull();
    expect(codeLanguageLabel({ mimeType: "text/plain", ext: "<svg" })).toBeNull();
    expect(codeLanguageLabel({ mimeType: "text/plain", ext: "" })).toBeNull();
  });
});
