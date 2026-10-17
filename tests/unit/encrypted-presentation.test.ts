import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decryptedPresentation,
  extOfName,
  MAX_INLINE_BYTES,
  SAVE_BLOB_TYPE,
} from "@/components/viewer/decrypted-presentation";
import { serveDecision } from "@/lib/media/mime";

/**
 * Decrypted bytes are rendered by US, in our origin, from a type that whoever
 * encrypted the file chose. A `blob:` URL inherits the creating page's origin,
 * so `new Blob([html], { type: "text/html" })` in an iframe is a live document
 * with our cookies - the stored XSS the raw route has always refused, arriving
 * through the one door that has no server in it.
 *
 * These tests are the door.
 */

/** Types whose whole point is that they execute if a browser is allowed to. */
const HOSTILE = [
  ["text/html", "index.html"],
  ["application/xhtml+xml", "page.xhtml"],
  ["image/svg+xml", "logo.svg"],
  ["text/xml", "feed.xml"],
  ["application/xml", "feed.xml"],
  ["application/javascript", "payload.js"],
  ["application/x-javascript", "payload.js"],
  ["text/html; charset=utf-8", "index.html"],
] as const;

describe("decrypted content is never promoted to a document", () => {
  for (const [mime, name] of HOSTILE) {
    it(`renders ${mime} as escaped text, never as markup`, () => {
      const shown = decryptedPresentation(mime, extOfName(name), 1024);
      expect(shown.mode).toBe("text");
      // No object URL is created at all for text, so there is nothing that
      // could be navigated to.
      expect(shown.renderType).toBeNull();
    });
  }

  it("saves everything as an inert type, whatever the file claims to be", () => {
    expect(SAVE_BLOB_TYPE).toBe("application/octet-stream");
  });

  it("only ever renders a type the raw route would also serve inline", () => {
    // The invariant that keeps this file honest as new types are added: if the
    // viewer is willing to hand a type to the browser, /raw would too, with the
    // same Content-Type. Anything else means the two have drifted and the
    // encrypted path has become the weaker one.
    const types = [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
      "image/svg+xml",
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska",
      "audio/mpeg",
      "audio/flac",
      "application/pdf",
      "application/zip",
      "text/plain",
      "text/html",
      "application/json",
      "application/octet-stream",
    ];
    for (const type of types) {
      const shown = decryptedPresentation(type, "", 1024);
      if (shown.renderType === null) continue;
      const served = serveDecision(type, "");
      expect(served.disposition, type).toBe("inline");
      expect(served.contentType, type).toBe(shown.renderType);
    }
  });

  it("shows an image only when it cannot carry script", () => {
    expect(decryptedPresentation("image/png", "png", 1024).mode).toBe("image");
    expect(decryptedPresentation("image/svg+xml", "svg", 1024).mode).not.toBe("image");
  });

  it("keeps PDF off the inline path even though /raw serves it inline", () => {
    // A deliberate asymmetry: a PDF viewer is a large attack surface, the file
    // was never seen by anything of ours, and the blob URL would carry our
    // origin. One extra click is the whole cost.
    expect(serveDecision("application/pdf", "pdf").disposition).toBe("inline");
    expect(decryptedPresentation("application/pdf", "pdf", 1024)).toEqual({
      mode: "download",
      renderType: null,
      reason: "not-inline-safe",
    });
  });

  it("plays a .mov under the name the decoder is registered against", () => {
    expect(decryptedPresentation("video/quicktime", "mov", 1024)).toEqual({
      mode: "video",
      renderType: "video/mp4",
      reason: null,
    });
  });

  it("falls back to the extension when the type says nothing", () => {
    // ShareX on Windows sends application/octet-stream for anything the
    // registry has no entry for, and that type is inside the container too.
    expect(decryptedPresentation("application/octet-stream", "png", 1024).mode).toBe("image");
    expect(decryptedPresentation("", "mp4", 1024).mode).toBe("video");
  });

  it("refuses to unpack a file too large for a browser tab", () => {
    expect(decryptedPresentation("image/png", "png", MAX_INLINE_BYTES + 1)).toEqual({
      mode: "download",
      renderType: null,
      reason: "too-large",
    });
    expect(decryptedPresentation("video/mp4", "mp4", MAX_INLINE_BYTES).mode).toBe("video");
  });

  it("reads an extension the way the serving layer does", () => {
    expect(extOfName("holiday.PNG")).toBe("png");
    expect(extOfName("archive.tar.gz")).toBe("gz");
    expect(extOfName("noextension")).toBe("");
    expect(extOfName("trailing.")).toBe("");
  });
});

describe("the viewer has no way to run decrypted markup", () => {
  const SOURCES = [
    "components/viewer/EncryptedViewer.tsx",
    "components/viewer/decrypt-transfer.ts",
    "components/viewer/decrypted-presentation.ts",
  ];

  for (const file of SOURCES) {
    it(`never renders markup itself: ${file}`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code).not.toContain("dangerouslySetInnerHTML");
      expect(code).not.toContain("srcDoc");
      expect(code).not.toContain("srcdoc");
      expect(code).not.toContain("<iframe");
      expect(code).not.toContain("document.write");
    });
  }
});
