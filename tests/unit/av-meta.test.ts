import { describe, it, expect } from "vitest";
import { parseAvProbe, parseRational } from "@/lib/media/av-probe";
import { avMetaFrom, frameCount, NO_AV_META } from "@/lib/media/av-meta";

/**
 * Every fixture below is output ffprobe 5.1.9 really produced, captured from
 * production files, not invented. That matters most for the three videos that
 * carry no `nb_frames`: they are the reason `fps` is stored at all, and a
 * hand-written fixture would never have thought to omit the field.
 */

/** The ShareX recording the complaint was about: 5056 px wide, 0.0044 bpp. */
const STUTTERING_CAPTURE = {
  programs: [],
  streams: [
    {
      codec_name: "h264",
      codec_type: "video",
      width: 5056,
      height: 1924,
      avg_frame_rate: "30/1",
      duration: "13.433333",
      nb_frames: "403",
      disposition: { attached_pic: 0 },
    },
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "13.434000" },
};
const STUTTERING_CAPTURE_BYTES = 2_179_538;

/** A WebM: the container gives a duration and a rate, but never a frame count. */
const WEBM_WITHOUT_FRAME_COUNT = {
  programs: [],
  streams: [
    {
      codec_name: "vp8",
      codec_type: "video",
      width: 768,
      height: 610,
      avg_frame_rate: "32/1",
      disposition: { attached_pic: 0 },
    },
  ],
  format: { format_name: "matroska,webm", duration: "15.409000" },
};

/** An MPEG-TS stream wearing an .mp4 name, with a variable frame rate. */
const VARIABLE_RATE = {
  programs: [],
  streams: [
    {
      codec_name: "h264",
      codec_type: "video",
      width: 48,
      height: 96,
      avg_frame_rate: "122972160/4355237",
      duration: "41.666667",
      disposition: { attached_pic: 0 },
    },
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "41.666667" },
};

/** A plain MP3, and the same MP3 with cover art bolted on. */
const MP3 = {
  programs: [],
  streams: [{ codec_name: "mp3", codec_type: "audio", disposition: { attached_pic: 0 } }],
  format: { format_name: "mp3", duration: "208.718367" },
};
const MP3_WITH_COVER = {
  programs: [],
  streams: [
    { codec_name: "mp3", codec_type: "audio", disposition: { attached_pic: 0 } },
    {
      codec_name: "png",
      codec_type: "video",
      width: 600,
      height: 600,
      nb_frames: "1",
      avg_frame_rate: "90000/1",
      disposition: { attached_pic: 1 },
    },
  ],
  format: { format_name: "mp3", duration: "208.718367" },
};

function metaOf(raw: unknown) {
  const probe = parseAvProbe(raw);
  expect(probe).not.toBeNull();
  return avMetaFrom(probe!);
}

describe("reading a frame rate out of ffprobe", () => {
  it("parses the rational form, which Number() cannot", () => {
    expect(parseRational("30/1")).toBe(30);
    expect(parseRational("60/1")).toBe(60);
    // A real variable-rate production file. Number("122972160/4355237") is NaN.
    expect(parseRational("122972160/4355237")).toBeCloseTo(28.235, 3);
    expect(parseRational("25")).toBe(25);
    expect(parseRational(29.97)).toBeCloseTo(29.97, 2);
  });

  it("treats every way of saying 'no idea' as null, never as zero", () => {
    // Zero would pass every "is this fast enough" comparison ever written, and
    // would make frameCount() answer 0 frames for a file full of them.
    for (const bad of ["0/0", "0/1", "1/0", "", "N/A", "abc/2", null, undefined, {}, -30]) {
      expect(parseRational(bad), String(bad)).toBeNull();
    }
  });
});

describe("projecting a probe onto the row's columns", () => {
  it("records what the stuttering ShareX capture actually is", () => {
    const meta = metaOf(STUTTERING_CAPTURE);
    expect(meta).toEqual({
      width: 5056,
      height: 1924,
      frames: 403,
      durationSeconds: 13.434,
      fps: 30,
    });
  });

  it("makes the recording's two defects computable from the row alone", () => {
    const meta = metaOf(STUTTERING_CAPTURE);
    const total = frameCount(meta);
    expect(total).toBe(403);

    // 1. Past 4096 px no hardware H.264 decoder will touch it, so the browser
    //    falls back to software and stutters however healthy the file is.
    expect(meta.width!).toBeGreaterThan(4096);

    // 2. And the encoder was given 0.0044 bits per pixel, against the 0.050 to
    //    0.098 the same user's watchable recordings measure. Both numbers now
    //    come out of the stored columns; before this work the row held nothing
    //    but a size, so neither question could even be asked.
    const bpp = (STUTTERING_CAPTURE_BYTES * 8) / (meta.width! * meta.height! * total!);
    expect(bpp).toBeCloseTo(0.00445, 5);
  });

  it("still yields a frame total when the container never counted", () => {
    const meta = metaOf(WEBM_WITHOUT_FRAME_COUNT);
    // The counted column stays empty, because nothing counted.
    expect(meta.frames).toBeNull();
    expect(meta.fps).toBe(32);
    expect(meta.durationSeconds).toBe(15.409);
    // 15.409 s at 32 fps. Estimated, and deliberately never written back into
    // uploads.frames - see the comment on frameCount().
    expect(frameCount(meta)).toBe(493);
  });

  it("handles a variable frame rate without turning it into NaN", () => {
    const meta = metaOf(VARIABLE_RATE);
    expect(meta.fps).toBeCloseTo(28.235, 3);
    expect(frameCount(meta)).toBe(1176);
  });

  it("gives audio a duration and nothing else", () => {
    const meta = metaOf(MP3);
    expect(meta).toEqual({
      width: null,
      height: null,
      frames: null,
      durationSeconds: 208.718367,
      fps: null,
    });
    expect(frameCount(meta)).toBeNull();
  });

  it("does not let cover art give an MP3 a picture size", () => {
    // Recording 600x600 here would make three minutes of audio look like a
    // photograph to every consumer that asks the row whether it has dimensions.
    const meta = metaOf(MP3_WITH_COVER);
    expect(meta.width).toBeNull();
    expect(meta.height).toBeNull();
    expect(meta.frames).toBeNull();
    expect(meta.durationSeconds).toBeCloseTo(208.72, 2);
  });

  it("reports nothing rather than zero when a probe measured nothing", () => {
    expect(frameCount(NO_AV_META)).toBeNull();
    // A duration with no rate, and a rate with no duration, are both unanswerable.
    expect(frameCount({ ...NO_AV_META, durationSeconds: 10 })).toBeNull();
    expect(frameCount({ ...NO_AV_META, fps: 30 })).toBeNull();
  });
});
