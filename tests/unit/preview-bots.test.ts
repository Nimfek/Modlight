import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDirectMediaBot, isPreviewBot } from "@/lib/media/bots";

/**
 * A link preview is not a reader. Getting this wrong is not a statistics
 * nuisance: a burn-after-view link whose preview is counted dies inside the chat
 * window, before the person it was sent to has clicked anything.
 */

const UNFURLERS = [
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  "TelegramBot (like TwitterBot)",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Mozilla/5.0 (compatible; Twitterbot/1.0)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "WhatsApp/2.23.20.0 A",
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Jakarta Commons-HttpClient/3.1)",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; Discordbot/2.0)",
];

const HUMANS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  "curl/8.5.0",
  "ShareX/16.1.0",
];

describe("preview bots", () => {
  for (const ua of UNFURLERS) {
    it(`recognises ${ua.slice(0, 32)}`, () => expect(isPreviewBot(ua)).toBe(true));
  }

  for (const ua of HUMANS) {
    it(`leaves ${ua.slice(0, 32)} alone`, () => expect(isPreviewBot(ua)).toBe(false));
  }

  it("treats a missing user agent as a reader", () => {
    // Cheap to under-detect (one extra view); expensive to over-detect (a real
    // visitor's view goes unrecorded).
    expect(isPreviewBot(null)).toBe(false);
    expect(isPreviewBot("")).toBe(false);
  });

  it("keeps the media-embedding subset inside the wider set", () => {
    expect(isDirectMediaBot("Discordbot/2.0")).toBe(true);
    // X reads markup only, so it gets the page, never a redirect to the bytes.
    expect(isDirectMediaBot("Twitterbot/1.0")).toBe(false);
    expect(isPreviewBot("Twitterbot/1.0")).toBe(true);
  });
});

describe("the raw route excludes unfurlers from the view counter", () => {
  it("consults the shared list before counting", () => {
    // og:image for a picture IS the raw URL, so an unfurl arrives here looking
    // exactly like a reader: no resize parameter, no Sec-Fetch-Dest.
    const source = readFileSync(
      join(process.cwd(), "app", "[userCode]", "[mediaCode]", "[action]", "route.ts"),
      "utf8",
    );
    expect(source).toContain("isPreviewBot");

    // ...but the exemption is scoped to files with NO view cap. User-Agent is
    // chosen by the caller, so honouring it on a capped file would let anyone
    // read a one-time link forever by claiming to be Discordbot.
    const exempt = source.slice(source.indexOf("const botExempt"));
    expect(exempt.slice(0, 200)).toContain("media.maxViews == null");

    const shouldCount = source.slice(source.indexOf("const shouldCount"));
    expect(shouldCount.slice(0, 300)).toContain("botExempt");
  });

  it("does not advertise a picture for a link with a view cap", () => {
    // The counter is only half of it: an unfurler copies og:image onto its own
    // CDN and serves it publicly forever, so previewing a burn-after-view link
    // publishes its content permanently. Capped files therefore carry no image.
    const source = readFileSync(join(process.cwd(), "lib", "media", "embed.ts"), "utf8");
    expect(source).toContain("hasViewCap");
  });
});
