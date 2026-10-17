import { describe, it, expect } from "vitest";
import {
  MAX_RENDER_BYTES,
  canRenderInline,
  mintRenderTicket,
  renderAdmission,
  renderContentType,
  renderCsp,
  sandboxShape,
  verifyRenderTicket,
} from "@/lib/media/render-ticket";
import { serveDecision } from "@/lib/media/mime";

const MEDIA = "9d2e1a54-0000-4000-8000-000000000001";
const OTHER = "9d2e1a54-0000-4000-8000-000000000002";

describe("what may be rendered at all", () => {
  it("accepts only the three markup types, and nothing that sniffs like them", () => {
    expect(sandboxShape("text/html")).toBe("html");
    expect(sandboxShape("Text/HTML; charset=UTF-8")).toBe("html");
    expect(sandboxShape("application/xhtml+xml")).toBe("html");
    expect(sandboxShape("image/svg+xml")).toBe("svg");
  });

  it("refuses everything else", () => {
    for (const mime of [
      "text/plain",
      "text/xml",
      "application/xml",
      "application/json",
      "application/javascript",
      "multipart/related", // .mhtml can smuggle a whole site into one file
      "message/rfc822",
      "application/pdf",
      "image/png",
      "",
      null,
      undefined,
    ]) {
      expect(sandboxShape(mime), String(mime)).toBeNull();
    }
  });

  it("offers the toggle only up to the size ceiling", () => {
    expect(canRenderInline({ mimeType: "text/html", size: 1024 })).toBe(true);
    expect(canRenderInline({ mimeType: "text/html", size: MAX_RENDER_BYTES })).toBe(true);
    expect(canRenderInline({ mimeType: "text/html", size: MAX_RENDER_BYTES + 1 })).toBe(false);
    expect(canRenderInline({ mimeType: "application/pdf", size: 10 })).toBe(false);
  });
});

describe("render tickets", () => {
  it("accepts a freshly minted ticket and reports the file it names", () => {
    expect(verifyRenderTicket(mintRenderTicket(MEDIA))).toBe(MEDIA);
  });

  it("rejects a ticket minted for another file", () => {
    const ticket = mintRenderTicket(OTHER);
    expect(verifyRenderTicket(ticket)).toBe(OTHER);
    expect(verifyRenderTicket(ticket)).not.toBe(MEDIA);
  });

  it("rejects a swapped id under a valid signature", () => {
    const [, exp, sig] = mintRenderTicket(MEDIA).split(".");
    expect(verifyRenderTicket(`${OTHER}.${exp}.${sig}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const ticket = mintRenderTicket(MEDIA);
    const [id, exp, sig] = ticket.split(".");
    const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(verifyRenderTicket(`${id}.${exp}.${flipped}`)).toBeNull();
    expect(verifyRenderTicket(`${id}.${exp}.${sig.slice(0, -2)}`)).toBeNull();
    expect(verifyRenderTicket(`${id}.${exp}.${sig}xx`)).toBeNull();
  });

  it("rejects an extended expiry, because the signature covers it", () => {
    const [id, , sig] = mintRenderTicket(MEDIA).split(".");
    const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
    expect(verifyRenderTicket(`${id}.${farFuture}.${sig}`)).toBeNull();
  });

  it("rejects an expired ticket", () => {
    expect(verifyRenderTicket(mintRenderTicket(MEDIA, -1))).toBeNull();
  });

  it("rejects malformed input instead of throwing", () => {
    for (const junk of ["", "garbage", ".", "..", "a.b", "a.b.c.d", "id.NaN.sig", "id.-1.sig", null, undefined]) {
      expect(verifyRenderTicket(junk), String(junk)).toBeNull();
    }
  });
});

describe("admission to the render endpoint", () => {
  const ticket = mintRenderTicket(MEDIA);

  it("lets a real frame load through", () => {
    expect(renderAdmission({ secFetchDest: "iframe", ticket })).toEqual({
      allow: true,
      mediaId: MEDIA,
    });
  });

  it("refuses a top-level navigation even with a perfect ticket", () => {
    // This is the phishing guard: a pasted /render link must never open as a
    // document of its own under our domain and our certificate.
    for (const dest of ["document", "empty", "object", "embed"]) {
      expect(renderAdmission({ secFetchDest: dest, ticket }), String(dest)).toEqual({
        allow: false,
        reason: "not-a-frame",
      });
    }
  });

  it("separates a missing destination from a declared top-level one", () => {
    // The two get opposite answers upstream: `not-a-frame` redirects to the
    // preview page, which is friendly for a real navigation but harmful in a
    // frame - it would render the whole preview page inside the frame and spend
    // a second view per click. With no header we cannot tell, so we refuse.
    for (const dest of ["", null, undefined]) {
      expect(renderAdmission({ secFetchDest: dest, ticket }), String(dest)).toEqual({
        allow: false,
        reason: "unknown-dest",
      });
    }
  });

  it("refuses a frame without a valid ticket", () => {
    expect(renderAdmission({ secFetchDest: "iframe", ticket: null })).toEqual({
      allow: false,
      reason: "bad-ticket",
    });
    expect(renderAdmission({ secFetchDest: "iframe", ticket: mintRenderTicket(MEDIA, -1) })).toEqual({
      allow: false,
      reason: "bad-ticket",
    });
  });
});

describe("response policy", () => {
  it("puts every rendered document in an opaque origin", () => {
    expect(renderCsp("html")).toContain("sandbox allow-scripts");
    expect(renderCsp("svg")).toContain("sandbox");
    // Script in an SVG is essentially always an attack, and nothing legitimate
    // about a vector drawing needs it.
    expect(renderCsp("svg")).not.toContain("allow-scripts");
    expect(renderCsp("svg")).not.toContain("script-src");
  });

  it("never grants same-origin, forms, popups or top navigation", () => {
    for (const shape of ["html", "svg"] as const) {
      const csp = renderCsp(shape);
      expect(csp).not.toContain("allow-same-origin");
      expect(csp).not.toContain("allow-forms");
      expect(csp).not.toContain("allow-popups");
      expect(csp).not.toContain("allow-top-navigation");
      expect(csp).not.toContain("allow-downloads");
      expect(csp).not.toContain("allow-modals");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain("frame-ancestors 'self'");
    }
  });

  it("labels the document as what it is", () => {
    expect(renderContentType("html")).toBe("text/html; charset=utf-8");
    expect(renderContentType("svg")).toBe("image/svg+xml; charset=utf-8");
  });
});

describe("the /raw contract is untouched", () => {
  it("still hands markup back as inert plain text", () => {
    // The sandbox is an ADDITION. If this ever regresses, an uploaded page runs
    // script on our origin through the URL that is in every ShareX config.
    expect(serveDecision("text/html")).toEqual({
      disposition: "inline",
      contentType: "text/plain; charset=utf-8",
    });
    expect(serveDecision("image/svg+xml")).toEqual({
      disposition: "inline",
      contentType: "text/plain; charset=utf-8",
    });
    expect(serveDecision("application/xhtml+xml")).toEqual({
      disposition: "inline",
      contentType: "text/plain; charset=utf-8",
    });
  });
});
