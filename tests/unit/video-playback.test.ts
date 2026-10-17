import { describe, it, expect } from "vitest";
import { playableVideoType, playableAudioType, serveDecision } from "@/lib/media/mime";

describe("video containers a browser can actually decode", () => {
  it("relabels ISO base media containers as mp4", () => {
    // The whole bug: a .mov off a phone or a screen recorder is H.264/AAC, which
    // every browser decodes - but Chrome and Firefox refuse the LABEL
    // "video/quicktime" without reading a byte, so the player showed its error
    // text while the thumbnail (which never consults the type) worked fine.
    expect(playableVideoType("video/quicktime", "mov")).toBe("video/mp4");
    expect(playableVideoType("video/x-m4v", "m4v")).toBe("video/mp4");
    expect(playableVideoType("video/3gpp", "3gp")).toBe("video/mp4");
  });

  it("passes through the types that were always fine", () => {
    expect(playableVideoType("video/mp4", "mp4")).toBe("video/mp4");
    expect(playableVideoType("video/webm", "webm")).toBe("video/webm");
    expect(playableVideoType("video/ogg", "ogv")).toBe("video/ogg");
  });

  it("refuses containers no browser ships a demuxer for", () => {
    // No label helps here, so the viewer must fall back to the download card
    // instead of rendering a player that can only display its own failure.
    for (const [mime, ext] of [
      ["video/x-matroska", "mkv"],
      ["video/x-msvideo", "avi"],
      ["video/x-ms-wmv", "wmv"],
      ["video/x-flv", "flv"],
      ["video/mpeg", "mpg"],
      ["video/mp2t", "ts"],
    ] as const) {
      expect(playableVideoType(mime, ext), `${mime}`).toBeNull();
    }
  });

  it("falls back to the extension when the stored type is useless", () => {
    // ShareX, curl and several phones send application/octet-stream, and an
    // imported row keeps whatever its old host guessed years ago.
    expect(playableVideoType("application/octet-stream", "mov")).toBe("video/mp4");
    expect(playableVideoType("application/octet-stream", "mp4")).toBe("video/mp4");
    expect(playableVideoType(null, "webm")).toBe("video/webm");
    expect(playableVideoType("application/octet-stream", "mkv")).toBeNull();
  });

  it("does not let the extension override a video type it already knows is dead", () => {
    // A .mkv renamed to .mp4 must not claim to be playable: the stored video/*
    // type is the stronger evidence, and a false claim means a silent failure.
    expect(playableVideoType("video/x-matroska", "mp4")).toBeNull();
  });
});

describe("the raw route agrees with the player", () => {
  it("hands a .mov to the browser under the name its decoder is registered against", () => {
    // A <video> reads the response header as much as the <source type>, so both
    // ends have to say the same thing or the player refuses anyway.
    expect(serveDecision("video/quicktime", "mov")).toEqual({
      disposition: "inline",
      contentType: "video/mp4",
    });
  });

  it("leaves an undecodable container as a download", () => {
    expect(serveDecision("video/x-matroska", "mkv").disposition).toBe("attachment");
  });

  it("keeps the existing behaviour for everything else", () => {
    expect(serveDecision("image/png", "png")).toEqual({
      disposition: "inline",
      contentType: "image/png",
    });
    // The anti-XSS contract is untouched.
    expect(serveDecision("text/html", "html")).toEqual({
      disposition: "inline",
      contentType: "text/plain; charset=utf-8",
    });
  });
});

describe("audio containers", () => {
  it("relabels the m4a family", () => {
    expect(playableAudioType("audio/x-m4a", "m4a")).toBe("audio/mp4");
    expect(playableAudioType("application/octet-stream", "mp3")).toBe("audio/mpeg");
  });

  it("refuses what no browser plays", () => {
    expect(playableAudioType("audio/x-ms-wma", "wma")).toBeNull();
  });
});
