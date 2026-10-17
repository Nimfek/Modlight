import { describe, it, expect } from "vitest";
import { mediaUrls } from "@/lib/media/urls";
import { config } from "@/lib/config";

/**
 * The one place that decides what an upload's public links LOOK like.
 *
 * It exists because the rule was previously written out at each call site and
 * one of them got it wrong in a way nothing could catch: ShareX kept handing
 * back /{tag}/{code} for accounts that had switched the tag segment off, because
 * only the profile page ever read the column. Now the ShareX finalize path and
 * the listing API the desktop client pages through call this, so the two cannot
 * describe the same file differently.
 */

const BASE = config.appUrl;

describe("mediaUrls", () => {
  it("puts the tag in both links by default", () => {
    expect(mediaUrls({ userCode: "ToqOse" }, "abc12", "png")).toEqual({
      url: `${BASE}/ToqOse/abc12.png`,
      rawUrl: `${BASE}/ToqOse/abc12/raw.png`,
    });
  });

  it("drops the tag from BOTH links when the account opted out", () => {
    // Both, not just the page link: a preview page on one scheme and a raw link
    // on the other is how a "shorter links" setting turns into two files.
    expect(mediaUrls({ userCode: "ToqOse", skipTagInUrl: true }, "abc12", "png")).toEqual({
      url: `${BASE}/abc12.png`,
      rawUrl: `${BASE}/abc12/raw.png`,
    });
  });

  it("treats a missing skipTagInUrl as off", () => {
    // The column is nullable, and rows predating it read as null. Anything other
    // than an explicit true has to keep the tag, or one migration silently
    // rewrites the link shape of every legacy account.
    for (const skip of [undefined, null, false]) {
      expect(mediaUrls({ userCode: "ToqOse", skipTagInUrl: skip }, "abc12", "png").url).toBe(
        `${BASE}/ToqOse/abc12.png`,
      );
    }
  });

  it("falls back to a placeholder tag rather than an empty segment", () => {
    // An account with no tag would otherwise produce "//abc12.png", which is a
    // protocol-relative URL pointing at a host called "abc12.png".
    expect(mediaUrls({ userCode: null }, "abc12", "png").url).toBe(`${BASE}/u/abc12.png`);
  });

  it("handles a file with no extension", () => {
    expect(mediaUrls({ userCode: "ToqOse" }, "abc12", "")).toEqual({
      url: `${BASE}/ToqOse/abc12`,
      rawUrl: `${BASE}/ToqOse/abc12/raw`,
    });
  });

  it("ignores a preferred domain the operator never configured", () => {
    // The value is user-editable and ends up in ShareX configs and copied links,
    // so an origin that is not in APP_DOMAINS must not be echoed back. Dropping
    // a domain from the config then heals the accounts pointing at it.
    const links = mediaUrls(
      { userCode: "ToqOse", preferredDomain: "https://evil.example" },
      "abc12",
      "png",
    );
    expect(links.url).toBe(`${BASE}/ToqOse/abc12.png`);
    expect(links.rawUrl).toBe(`${BASE}/ToqOse/abc12/raw.png`);
  });
});
