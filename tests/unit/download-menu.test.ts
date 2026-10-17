import { describe, it, expect } from "vitest";
import {
  downloadHintKey,
  downloadOptionsFor,
  sectionHeadingKey,
  type DownloadOption,
} from "@/lib/media/download-menu";
import { avOptionFor } from "@/lib/media/av-targets";
import { convertOptionFor } from "@/lib/media/convert-targets";

const OWNER = { canEncode: true };
const STRANGER = { canEncode: false };
const names = (o: { to: string }[]) => o.map((x) => x.to);
const main = (o: DownloadOption[]) => names(o.filter((x) => x.section === "main"));
const frame = (o: DownloadOption[]) => names(o.filter((x) => x.section === "frame"));

describe("what each kind of file is offered", () => {
  it("gives a video other video formats, a moving clip and its sound", () => {
    // The report this rebuild came from, in one line: a .mp4 used to offer
    // png, jpg, m4a, mp3, gif and webp - no video format at all.
    expect(names(downloadOptionsFor("video/mp4", "mp4", null, OWNER))).toEqual([
      "mov",
      "mkv",
      "gif",
      "mp3",
    ]);
  });

  it("gives an audio file other sound formats and a postable video", () => {
    expect(names(downloadOptionsFor("audio/mpeg", "mp3", null, OWNER))).toEqual([
      "ogg",
      "wav",
      "mp4",
    ]);
  });

  it("never offers a file the format it already is", () => {
    for (const [mime, ext, self] of [
      ["image/png", "png", "png"],
      ["image/jpeg", "jpg", "jpg"],
      ["image/webp", "webp", "webp"],
      ["image/avif", "avif", "avif"],
      ["video/mp4", "mp4", "mp4"],
      ["audio/mpeg", "mp3", "mp3"],
    ] as const) {
      const offered = names(downloadOptionsFor(mime, ext, 1, OWNER));
      expect(offered, `${mime} -> ${self}`).not.toContain(self);
    }
  });

  it("keeps the two conversions worth doing to an ordinary picture", () => {
    // The user read these as animation formats and called them pointless. They
    // are not: a PNG screenshot becomes a WebP about an eighth its size, and
    // they are the whole reason "download as" exists for a screenshot.
    const png = downloadOptionsFor("image/png", "png", 1, OWNER);
    expect(names(png)).toEqual(["pdf", "jpg", "webp", "avif"]);
  });

  it("says nothing under a still picture's targets, because the size line does", () => {
    // "usually about half the size, same quality" was measurably false (0.125x
    // from PNG, 0.74x from JPEG). The predicted size replaced it.
    const png = downloadOptionsFor("image/png", "png", 1, OWNER);
    expect(downloadHintKey(png.find((o) => o.to === "avif")!)).toBeNull();
    expect(downloadHintKey(png.find((o) => o.to === "webp")!)).toBeNull();
  });

  it("sends a picture to libvips and a clip to ffmpeg", () => {
    expect(
      downloadOptionsFor("image/png", "png", 1, OWNER).every((o) => o.engine === "image"),
    ).toBe(true);
    expect(downloadOptionsFor("video/mp4", "mp4", null, OWNER).every((o) => o.engine === "av")).toBe(
      true,
    );
    expect(downloadOptionsFor("audio/mpeg", "mp3", null, OWNER).every((o) => o.engine === "av")).toBe(
      true,
    );
  });

  it("lets both engines serve an animation, and never twice under one name", () => {
    // A GIF is genuinely claimed by both: sharp keeps its motion in WebP, ffmpeg
    // makes it an MP4 seventy times smaller. An AVIF sequence names WebP in both
    // engines, and ffmpeg has to win - it is the one that reaches all 43 frames.
    const gif = downloadOptionsFor("image/gif", "gif", 60, OWNER);
    expect(main(gif)).toEqual(["mp4", "webp"]);
    expect(gif.find((o) => o.to === "mp4")!.engine).toBe("av");
    expect(gif.find((o) => o.to === "webp")!.engine).toBe("image");

    const avif = downloadOptionsFor("image/avif", "avif", null, OWNER);
    expect(main(avif)).toEqual(["gif", "webp"]);
    expect(avif.find((o) => o.to === "webp")!.engine).toBe("av");
    expect(names(avif).filter((n) => n === "webp")).toHaveLength(1);
  });
});

describe("what keeps the motion and what throws it away", () => {
  it("puts every frame-only target below the ones that keep the animation", () => {
    const gif = downloadOptionsFor("image/gif", "gif", 60, OWNER);
    expect(main(gif)).toEqual(["mp4", "webp"]);
    expect(frame(gif)).toEqual(["pdf", "png", "jpg", "avif"]);
    // ...and in that order in the array the menu renders from, so a still can
    // never appear above something that keeps the motion.
    const firstFrame = gif.findIndex((o) => o.section === "frame");
    expect(gif.slice(firstFrame).every((o) => o.section === "frame")).toBe(true);
  });

  it("heads the frame group once, not once per entry", () => {
    const gif = downloadOptionsFor("image/gif", "gif", 60, OWNER);
    const headings = gif.map((o, i) => sectionHeadingKey(o, gif[i - 1])).filter(Boolean);
    expect(headings).toEqual(["convert.frameSection"]);
    // A file with nothing to lose gets no heading at all.
    const png = downloadOptionsFor("image/png", "png", 1, OWNER);
    expect(png.map((o, i) => sectionHeadingKey(o, png[i - 1])).filter(Boolean)).toEqual([]);
  });

  it("never warns about losing an animation from a file that has none", () => {
    // The label that made the user distrust the whole menu: a one-frame WebP was
    // told, under every target, that it would come back as "a single frame".
    const still = downloadOptionsFor("image/webp", "webp", 1, OWNER);
    expect(still.every((o) => o.section === "main" && downloadHintKey(o) !== "convert.singleFrame"))
      .toBe(true);

    // A file nobody has counted - every imported one - says "if". It is not
    // demoted to the frame group either, because it may well be a still.
    const unknown = downloadOptionsFor("image/webp", "webp", null, OWNER);
    expect(downloadHintKey(unknown.find((o) => o.to === "png")!)).toBe("convert.frameIfAnimated");
    expect(frame(unknown)).toEqual([]);

    // Once it IS known to move, the warning is unconditional.
    const animated = downloadOptionsFor("image/webp", "webp", 40, OWNER);
    expect(downloadHintKey(animated.find((o) => o.to === "png")!)).toBe("convert.singleFrame");
  });
});

describe("who is shown what", () => {
  it("hides the encoder-backed targets from a stranger", () => {
    // Those answer 403 on a public link, so showing them would be a menu of
    // things that do not work. The route enforces the same rule independently.
    const publicView = downloadOptionsFor("video/x-matroska", "mkv", null, STRANGER);
    expect(names(publicView)).toEqual(["mp4", "mov"]);
    expect(publicView.every((o) => o.cost === "copy")).toBe(true);
  });

  it("shows the owner everything the route will accept", () => {
    expect(names(downloadOptionsFor("video/x-matroska", "mkv", null, OWNER))).toEqual([
      "mp4",
      "mov",
      "gif",
      "mp3",
    ]);
  });

  it("never hands a stranger an entry the route will refuse", () => {
    // The AVIF sequence caught this: with the encoder-backed entries filtered
    // out, libvips was free to claim `webp` again - so the public menu drew it,
    // the route dispatched to ffmpeg (which claims that name for this file) and
    // ffmpeg answered 403. The dedupe has to run against what ffmpeg claims, not
    // against what this viewer may run.
    const publicView = downloadOptionsFor("image/avif", "avif", null, STRANGER);
    expect(names(publicView)).not.toContain("webp");
    expect(publicView.every((o) => o.engine === "image")).toBe(true);
    for (const option of publicView) {
      expect(avOptionFor("image/avif", "avif", null, option.to), option.to).toBeNull();
    }
    // ...and it is still described as costing this file its motion.
    expect(main(publicView)).toEqual([]);
  });

  it("offers a stranger nothing at all for an audio file", () => {
    // Every audio target re-encodes, so there is no cheap half to expose.
    expect(downloadOptionsFor("audio/mpeg", "mp3", null, STRANGER)).toEqual([]);
  });

  it("still shows a stranger every picture conversion", () => {
    // Those go through libvips, whose budget is enforced in transform-cost.ts
    // and has always been public. Nothing about this change narrows that.
    expect(names(downloadOptionsFor("image/png", "png", 1, STRANGER))).toEqual([
      "pdf",
      "jpg",
      "webp",
      "avif",
    ]);
  });
});

describe("the menu and the route", () => {
  it("only ever displays a target the matching route will admit", () => {
    // The invariant the whole module exists for, checked over the product of
    // every kind of file and every target name.
    const files = [
      ["video/x-matroska", "mkv"],
      ["video/mp4", "mp4"],
      ["video/quicktime", "mov"],
      ["video/webm", "webm"],
      ["audio/mpeg", "mp3"],
      ["audio/wav", "wav"],
      ["image/avif", "avif"],
      ["image/png", "png"],
      ["image/gif", "gif"],
      ["application/zip", "zip"],
    ] as const;

    for (const [mime, ext] of files) {
      for (const option of downloadOptionsFor(mime, ext, null, OWNER)) {
        const admitted =
          option.engine === "av"
            ? avOptionFor(mime, ext, null, option.to) !== null
            : convertOptionFor(mime, ext, null, option.to) !== null;
        expect(admitted, `${mime} -> ${option.to} (${option.engine})`).toBe(true);
      }
    }
  });

  it("resolves a name both engines claim the same way the route does", () => {
    // The route tries ffmpeg first, so on an AVIF sequence `?to=webp` is the
    // animated one. The menu has to agree, or the entry lies about its output.
    const option = downloadOptionsFor("image/avif", "avif", null, OWNER).find(
      (o) => o.to === "webp",
    )!;
    expect(option.engine).toBe("av");
    expect(avOptionFor("image/avif", "avif", null, "webp")).not.toBeNull();
  });
});

describe("what the menu says an entry does", () => {
  it("explains a container swap without saying the word remux", () => {
    const mkv = downloadOptionsFor("video/x-matroska", "mkv", null, OWNER);
    expect(downloadHintKey(mkv.find((o) => o.to === "mp4")!)).toBe("convert.containerCopy");
  });

  it("distinguishes a video's soundtrack from an audio file's re-encode", () => {
    expect(
      downloadHintKey(downloadOptionsFor("video/mp4", "mp4", null, OWNER).find((o) => o.to === "mp3")!),
    ).toBe("convert.audioTrack");
    expect(
      downloadHintKey(downloadOptionsFor("audio/wav", "wav", null, OWNER).find((o) => o.to === "mp3")!),
    ).toBe("convert.audioFormat");
  });

  it("warns that a GIF made from a video is a short silent excerpt", () => {
    const video = downloadOptionsFor("video/mp4", "mp4", null, OWNER);
    expect(downloadHintKey(video.find((o) => o.to === "gif")!)).toBe("convert.animationClip");
  });

  it("promises the whole animation where the whole animation is what comes out", () => {
    const avif = downloadOptionsFor("image/avif", "avif", null, OWNER);
    expect(downloadHintKey(avif.find((o) => o.to === "gif")!)).toBe("convert.keepsMotion");
    const gif = downloadOptionsFor("image/gif", "gif", 60, OWNER);
    expect(downloadHintKey(gif.find((o) => o.to === "mp4")!)).toBe("convert.keepsMotion");
    expect(downloadHintKey(gif.find((o) => o.to === "webp")!)).toBe("convert.keepsAnimation");
  });

  it("says what an audio file becomes when it is given a picture", () => {
    const audio = downloadOptionsFor("audio/mpeg", "mp3", null, OWNER);
    expect(downloadHintKey(audio.find((o) => o.to === "mp4")!)).toBe("convert.audioAsVideo");
  });

  it("names a key that exists in both locales", async () => {
    // A hint key with no translation renders the raw dotted path in the menu.
    const en = (await import("../../messages/en/files.json")).default as Record<string, unknown>;
    const pl = (await import("../../messages/pl/files.json")).default as Record<string, unknown>;

    const files = [
      ["video/x-matroska", "mkv"],
      ["video/mp4", "mp4"],
      ["audio/mpeg", "mp3"],
      ["image/avif", "avif"],
      ["image/gif", "gif"],
      ["image/png", "png"],
      ["image/webp", "webp"],
    ] as const;

    const keys = new Set<string>();
    for (const [mime, ext] of files) {
      for (const frames of [null, 1, 40]) {
        const options = downloadOptionsFor(mime, ext, frames, OWNER);
        options.forEach((o, i) => {
          const hint = downloadHintKey(o);
          if (hint) keys.add(hint);
          const heading = sectionHeadingKey(o, options[i - 1]);
          if (heading) keys.add(heading);
        });
      }
    }
    expect(keys.size).toBeGreaterThan(6);

    for (const key of keys) {
      const [group, leaf] = key.split(".");
      expect((en[group] as Record<string, string>)?.[leaf], `en ${key}`).toBeTruthy();
      expect((pl[group] as Record<string, string>)?.[leaf], `pl ${key}`).toBeTruthy();
    }
  });
});
