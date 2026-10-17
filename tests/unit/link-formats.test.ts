import { describe, it, expect } from "vitest";
import { buildLinkFormats } from "@/lib/media/link-formats";

const base = { url: "https://x/u/c.png", rawUrl: "https://x/u/c/raw.png", filename: "shot.png" };

describe("buildLinkFormats", () => {
  it("image formats point at the raw URL", () => {
    const f = buildLinkFormats({ ...base, isImage: true });
    expect(f.direct).toBe(base.url);
    expect(f.raw).toBe(base.rawUrl);
    expect(f.markdown).toBe("![shot.png](https://x/u/c/raw.png)");
    expect(f.bbcode).toBe("[img]https://x/u/c/raw.png[/img]");
    expect(f.html).toContain("<img");
  });

  it("non-image formats use plain links", () => {
    const f = buildLinkFormats({ ...base, isImage: false });
    expect(f.markdown).toBe("[shot.png](https://x/u/c.png)");
    expect(f.bbcode).toBe("[url]https://x/u/c.png[/url]");
    expect(f.html).toContain("<a href");
  });
});
