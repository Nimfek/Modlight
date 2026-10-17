import { describe, it, expect } from "vitest";
import {
  effectiveType,
  isDisplayableImage,
  isEmbeddable,
  mustBeEscaped,
  mediaKind,
  serveDecision,
} from "@/lib/media/mime";

describe("mime helpers", () => {
  it("isDisplayableImage", () => {
    expect(isDisplayableImage("image/png")).toBe(true);
    expect(isDisplayableImage("image/svg+xml")).toBe(false);
    expect(isDisplayableImage("application/pdf")).toBe(false);
    expect(isDisplayableImage(null)).toBe(false);
  });

  it("isEmbeddable", () => {
    expect(isEmbeddable("video/mp4")).toBe(true);
    expect(isEmbeddable("image/webp")).toBe(true);
    expect(isEmbeddable("application/zip")).toBe(false);
  });

  it("mustBeEscaped flags SVG/HTML (anti-XSS)", () => {
    expect(mustBeEscaped("image/svg+xml")).toBe(true);
    expect(mustBeEscaped("text/html")).toBe(true);
    expect(mustBeEscaped("image/png")).toBe(false);
  });

  it("mediaKind", () => {
    expect(mediaKind("image/png")).toBe("image");
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("text/plain")).toBe("text");
    expect(mediaKind("application/pdf")).toBe("pdf");
    expect(mediaKind("application/zip")).toBe("archive");
    expect(mediaKind("image/svg+xml")).toBe("other");
    expect(mediaKind("application/octet-stream")).toBe("other");
  });
});

describe("a stored type that says nothing falls back to the name", () => {
  it("consults the extension only when the stored type is useless", () => {
    expect(effectiveType("image/png", "gif")).toBe("image/png"); // stored type wins
    expect(effectiveType("application/octet-stream", "avif")).toBe("image/avif");
    expect(effectiveType("Image/PNG; charset=x", "")).toBe("image/png");
    expect(effectiveType("application/octet-stream", "gr2")).toBe("application/octet-stream");
    expect(effectiveType(null, null)).toBe("");
  });

  it("gives the reported .avif its preview, its display and its card back", () => {
    // One row, three symptoms, one cause: mime_type was application/octet-stream.
    expect(mediaKind("application/octet-stream", "avif")).toBe("image");
    expect(isDisplayableImage("application/octet-stream", "avif")).toBe(true);
    expect(isEmbeddable("application/octet-stream", "avif")).toBe(true);
    expect(serveDecision("application/octet-stream", "avif")).toEqual({
      disposition: "inline",
      contentType: "image/avif",
    });
  });

  it("does NOT hand markup its own content type through the same door", () => {
    // The fallback is allowed to make a file viewable; it is never allowed to
    // make one executable in our origin. serveDecision stays an allowlist.
    expect(serveDecision("application/octet-stream", "svg")).toEqual({
      disposition: "inline",
      contentType: "text/plain; charset=utf-8",
    });
    expect(serveDecision("application/octet-stream", "html")).toEqual({
      disposition: "inline",
      contentType: "text/plain; charset=utf-8",
    });
    expect(serveDecision("application/octet-stream", "xhtml")).toEqual({
      disposition: "inline",
      contentType: "text/plain; charset=utf-8",
    });
    expect(isDisplayableImage("application/octet-stream", "svg")).toBe(false);
  });

  it("leaves a genuinely unknown binary as a download", () => {
    expect(serveDecision("application/octet-stream", "gr2")).toEqual({
      disposition: "attachment",
      contentType: "application/octet-stream",
    });
    expect(mediaKind("application/octet-stream", "gr2")).toBe("other");
  });
});
