import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards on the player that unit tests of pure functions cannot express.
 *
 * The three properties below are the ones that were expensive to get right and
 * are cheap to break by accident from another file: the browser must never be
 * asked to decode a container it has no demuxer for, the page must never fetch
 * a whole video to draw a still, and the controls must not carry a colour of
 * their own into twelve skins.
 */
const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

const player = read("components", "viewer", "MediaPlayer.tsx");
const viewer = read("components", "viewer", "MediaViewer.tsx");
const css = read("app", "globals.css");

describe("the player never decides for itself what is playable", () => {
  it("takes the type from the caller instead of asking the element", () => {
    // lib/media/mime.ts owns that decision (a .mov is advertised as video/mp4
    // and plays, a .mkv gets the download card); a canPlayType probe here would
    // reopen the dead-player bug from the other side.
    expect(player).not.toMatch(/\.canPlayType\(/);
    expect(player).toContain("<source src={src} type={type} />");
  });

  it("is mounted only inside the branch that already proved the file plays", () => {
    expect(viewer).toContain("const playType = playableVideoType(mimeType, ext);");
    expect(viewer).toContain("if (!playType) {");
    expect(viewer).toMatch(/<MediaPlayer\s+src=\{rawUrl\}\s+type=\{playType\}/);
  });
});

describe("what the player fetches for itself stays same-origin", () => {
  /**
   * The scrub-bar preview track and the poster are fetched by the PAGE, not by
   * a person: a text track is loaded under CORS rules and the sprite sheet is
   * pulled by an `<img crossorigin>` inside the player's shadow root. This
   * deployment answers on three hostnames with no CORS headers between them
   * and the owner's preferred one is not necessarily the one the visitor is
   * on, so both have to be paths. mediaActionPath is the only way to build one.
   */
  const page = read("app", "[userCode]", "[mediaCode]", "page.tsx");

  it("builds both from mediaActionPath, which cannot carry an origin", () => {
    expect(page).toContain("mediaActionPath(ownerUserCode, media.code, TIMELINE_TRACK_ACTION)");
    expect(page).toContain('mediaActionPath(ownerUserCode, media.code, "raw")');
    // The poster is a RESIZE request. Without `w` the same URL is the file.
    expect(page).toMatch(/mediaActionPath\(ownerUserCode, media\.code, "raw"\)\}\?w=/);
  });

  it("never hands the player a URL built from the owner's hostname", () => {
    // `raw`/`page`/`dl` above are absolute (ownerBase); passing one of those as
    // the track would be the cross-origin failure this guards.
    expect(page).not.toMatch(/timelineTrack=\{(raw|page|dl)\b/);
    expect(page).not.toMatch(/posterUrl=\{(raw|page|dl)\b/);
  });
});

describe("a poster the browser cannot load is taken back off", () => {
  it("probes the poster and withdraws the attribute when it fails", () => {
    // Measured in Chrome: a <video> whose poster 404s paints NOTHING - not the
    // first decoded frame, an empty rectangle - and fires no event on the
    // element to say so. The endpoint refuses honestly (415 past the ffmpeg
    // input ceiling or with no video stream, 503 when the queue is full), so
    // without this the busy path costs the visitor the picture entirely.
    expect(player).toContain("new Image()");
    expect(player).toContain("setFailedPoster(poster)");
    expect(player).toContain("poster={poster && failedPoster !== poster ? poster : undefined}");
  });
});

describe("the frame-step keys stay off media-chrome's own", () => {
  it("acts on the unshifted comma and period only", () => {
    // Shifted, those two keys are `<` and `>`, which the library already spends
    // on playback rate - so the modifier check is the whole separation.
    expect(player).toContain('if (event.key !== "," && event.key !== ".") return;');
    expect(player).toContain(
      "if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;",
    );
  });

  it("listens on the controller rather than on the document", () => {
    // A document listener would take punctuation away from the rest of the
    // page - the copy-link row and the Formats menu sit a few pixels below.
    expect(player).toContain("onKeyDown={onKeyDown}");
    expect(player).not.toMatch(/(document|window)\.addEventListener\(\s*"keydown"/);
  });
});

describe("volume is remembered by the library, not by a second writer", () => {
  it("adds no persistence of its own and switches none of the library's off", () => {
    // media-chrome writes media-chrome-pref-volume / -muted itself, inside its
    // own try/catch, and restores them when the media element is attached. A
    // second layer here would race it, and the visible symptom of losing that
    // race is a player that un-mutes itself.
    expect(player).not.toMatch(/localStorage\.(get|set|remove)Item/);
    expect(player).not.toMatch(/\b(novolumepref|nomutedpref)=/);
  });

  it("leaves the playback rate unpersisted, which is the asked-for split", () => {
    // The library has no pref branch for the rate at all; this pins the fact
    // that nothing here adds one.
    const rate = read("node_modules", "media-chrome", "dist", "media-store", "state-mediator.js");
    const block = rate.slice(rate.indexOf("mediaPlaybackRate:"), rate.indexOf("mediaMuted:"));
    expect(block).not.toContain("localStorage");
    expect(rate).toContain('"media-chrome-pref-volume"');
  });
});

describe("the player still streams instead of downloading", () => {
  // preload="metadata" and the shape of the poster attribute are asserted
  // against the rendered markup in player-ssr.test.ts; what only the source can
  // show is that the library is not pulled onto every page that imports this
  // component.
  it("loads the control library lazily, so an image page never pays for it", () => {
    expect(player).not.toMatch(/^import .* from "media-chrome/m);
    expect(player).toContain('import("media-chrome/dist/media-controller.js")');
  });
});

describe("the controls are painted only with theme tokens", () => {
  /** Every rule block whose selector mentions the player. */
  const blocks = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector.includes(".ml-player"))
    .map(([, selector, body]) => ({ selector: selector.trim(), body }));

  it("finds the player block at all", () => {
    expect(blocks.length).toBeGreaterThan(5);
  });

  it("names no colour of its own", () => {
    // A hex or an oklch() here is a colour that survives a skin change, which
    // is exactly how a player starts looking like a foreign object in win98,
    // mono, riso or grimoire.
    const offenders = blocks
      .filter(({ body }) => /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/i.test(body))
      .map(({ selector }) => selector);
    expect(offenders).toEqual([]);
  });

  it("uses the raw tokens, not the Tailwind aliases it tree-shakes away", () => {
    // --color-card and --radius-lg exist only inside @theme inline; Tailwind v4
    // drops the unused ones, so referencing them from plain CSS yields nothing.
    const offenders = blocks
      .filter(({ body }) => /var\(--(?:color-|radius-(?:sm|lg|xl))/.test(body))
      .map(({ selector }) => selector);
    expect(offenders).toEqual([]);
  });
});
