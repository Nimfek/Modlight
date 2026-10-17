import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MediaPlayer } from "@/components/viewer/MediaPlayer";

/**
 * The player has to survive server rendering, because the preview page is
 * public and is what a link in a chat window opens. Two things are checked
 * here that only a real render can show: nothing from media-chrome executes on
 * the server (it is behind a dynamic import in an effect), and the HTML that
 * arrives before any JavaScript runs already contains a working native player.
 */
function render(locale: "en" | "pl", props: Record<string, unknown> = {}) {
  const messages = {
    viewer: JSON.parse(
      readFileSync(join(process.cwd(), "messages", locale, "viewer.json"), "utf8"),
    ),
  };
  return renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale, messages, children: null } as never,
      createElement(MediaPlayer, {
        src: "/AbCdE/xy12ab/raw.mp4",
        type: "video/mp4",
        unsupported: "no video",
        ...props,
      } as never),
    ),
  );
}

describe("the player server-renders", () => {
  const html = render("en");

  it("emits the controller and the control bar as real markup", () => {
    expect(html).toContain("<media-controller");
    expect(html).toContain("<media-control-bar>");
    expect(html).toContain("<media-fullscreen-button>");
  });

  it("ships a usable native player for the window before hydration", () => {
    // If the chunk is slow, blocked or fails, this is the whole player. The
    // control bar stays hidden until the elements upgrade (:not(:defined) in
    // globals.css), so the two never show at once.
    expect(html).toMatch(/<video[^>]*\scontrols(\s|=|>)/);
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('<source src="/AbCdE/xy12ab/raw.mp4" type="video/mp4"/>');
  });

  it("asks for no poster and no preview track when the page offers neither", () => {
    // Both are opt-in, and every branch that cannot have one passes null: an
    // <img> pointed at a URL that 415s and a <track> that never loads are both
    // requests made for nothing, once per page view.
    expect(html).not.toMatch(/\sposter=/);
    expect(html).not.toContain("<track");
  });

  it("carries a poster only as a resize request, never as the file", () => {
    // The old rule here was "a video never has a poster", because /raw for a
    // video used to mean the whole file. It now answers a resize request with
    // a seeked frame - but ONLY a resize request, so the `w` is the guarantee.
    const posted = render("en", { poster: "/AbCdE/xy12ab/raw?w=800" });
    expect(posted).toContain('poster="/AbCdE/xy12ab/raw?w=800"');
    expect(posted).toMatch(/poster="[^"]*[?&]w=\d+/);
  });

  it("declares the preview track exactly the way media-chrome looks it up", () => {
    // `label="thumbnails"` is a literal selector in media-store/request-map.js,
    // and without `default` the browser leaves the track disabled and never
    // parses a cue - so the preview would be silently dead with no error.
    const tracked = render("en", { timelineTrack: "/AbCdE/xy12ab/timeline.vtt" });
    expect(tracked).toMatch(/<track[^>]*\skind="metadata"/);
    expect(tracked).toMatch(/<track[^>]*\slabel="thumbnails"/);
    expect(tracked).toMatch(/<track[^>]*\sdefault(\s|=|\/|>)/);
    // A path, so the sheet its cues name resolves next to it on the page's own
    // origin. An absolute URL here is the cross-origin failure.
    expect(tracked).toMatch(/<track[^>]*\ssrc="\/[^"]*timeline\.vtt"/);
  });

  it("never puts a track or a poster on the audio player", () => {
    const audio = render("en", {
      variant: "audio",
      timelineTrack: "/AbCdE/xy12ab/timeline.vtt",
      poster: "/AbCdE/xy12ab/raw?w=800",
    });
    expect(audio).not.toContain("<track");
    expect(audio).not.toMatch(/\sposter=/);
  });

  it("labels the player for a screen reader in the reader's own language", () => {
    expect(render("en")).toContain('aria-label="video player"');
    expect(render("pl")).toContain('aria-label="odtwarzacz wideo"');
    expect(render("pl", { variant: "audio" })).toContain('aria-label="odtwarzacz dźwięku"');
  });

  it("renders the audio variant without the video-only chrome", () => {
    const audio = render("en", { variant: "audio" });
    expect(audio).toContain("<audio");
    expect(audio).toContain('audio=""');
    expect(audio).toContain('preload="metadata"');
    expect(audio).toMatch(/<audio[^>]*\scontrols(\s|=|>)/);
    expect(audio).not.toContain("<media-fullscreen-button>");
    expect(audio).not.toContain("<media-loading-indicator");
  });
});
