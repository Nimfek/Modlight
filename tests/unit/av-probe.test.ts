import { describe, it, expect } from "vitest";
import { parseAvProbe } from "@/lib/media/av-probe";

/** The exact shape ffprobe 5.1.9 emitted for the production .mkv. */
const REAL_VIDEO = {
  programs: [],
  streams: [
    {
      codec_name: "h264",
      codec_type: "video",
      width: 1280,
      height: 720,
      nb_frames: "968",
      duration: "32.231000",
      disposition: { attached_pic: 0 },
    },
    {
      codec_name: "aac",
      codec_type: "audio",
      duration: "32.234646",
      nb_frames: "1511",
      disposition: { attached_pic: 0 },
    },
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "32.234646" },
};

/** ...and for the animated AVIF from the bug report. */
const REAL_AVIF = {
  programs: [],
  streams: [
    {
      codec_name: "av1",
      codec_type: "video",
      width: 274,
      height: 498,
      duration: "2.150000",
      nb_frames: "43",
      disposition: { attached_pic: 0 },
    },
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.150000" },
};

describe("reading what ffprobe says", () => {
  it("maps a container family to the single demuxer we will force", () => {
    const probe = parseAvProbe(REAL_VIDEO);
    // `-f mov` is what stops ffmpeg from ever choosing the concat demuxer for
    // this file. Measured: without it, a text file naming /tmp/secret.txt is
    // read as an ffconcat playlist.
    expect(probe?.container).toBe("mov");
    expect(probe?.formatName).toBe("mov,mp4,m4a,3gp,3g2,mj2");
  });

  it("reads the streams, duration and codecs of a real video", () => {
    const probe = parseAvProbe(REAL_VIDEO);
    expect(probe?.video?.codec).toBe("h264");
    expect(probe?.video?.width).toBe(1280);
    expect(probe?.video?.height).toBe(720);
    expect(probe?.audio?.codec).toBe("aac");
    expect(probe?.duration).toBeCloseTo(32.23, 1);
  });

  it("sees all 43 frames of the AVIF sequence libvips reports as one", () => {
    const probe = parseAvProbe(REAL_AVIF);
    expect(probe?.video?.frames).toBe(43);
    expect(probe?.video?.codec).toBe("av1");
    expect(probe?.audio).toBeNull();
  });

  it("refuses a container that is not on the allowlist", () => {
    // Everything absent from the list is a way to make one file mean many -
    // concat, hls, dash - which is the shape of every local-file-disclosure bug
    // in this area.
    for (const format_name of ["concat", "hls", "dash", "lavfi", "image2", "tty"]) {
      expect(parseAvProbe({ format: { format_name }, streams: [] }), format_name).toBeNull();
    }
  });

  it("does not mistake cover art for a video track", () => {
    // An MP3 with an embedded JPEG reports a one-frame `video` stream. Treating
    // it as video would offer "grab a frame at 00:30" for a file that is thirty
    // minutes of audio, and would make remuxVerdict say yes to an MP3.
    const withArt = parseAvProbe({
      format: { format_name: "mp3", duration: "212.5" },
      streams: [
        { codec_name: "mp3", codec_type: "audio", disposition: { attached_pic: 0 } },
        {
          codec_name: "png",
          codec_type: "video",
          width: 600,
          height: 600,
          disposition: { attached_pic: 1 },
        },
      ],
    });
    expect(withArt?.video).toBeNull();
    expect(withArt?.audio?.codec).toBe("mp3");
    // ...but the stream is still visible to anything that wants the full list.
    expect(withArt?.streams).toHaveLength(2);
  });

  it("falls back to a stream duration when the container omits one", () => {
    const probe = parseAvProbe({
      format: { format_name: "matroska,webm" },
      streams: [
        {
          codec_name: "h264",
          codec_type: "video",
          width: 640,
          height: 480,
          duration: "12.5",
          disposition: { attached_pic: 0 },
        },
      ],
    });
    // Without this, a thin Matroska header reads as "unknown length" and every
    // whole-file encode refuses it.
    expect(probe?.duration).toBe(12.5);
  });

  it("reports an unknown duration as null rather than as zero", () => {
    const probe = parseAvProbe({
      format: { format_name: "mpegts" },
      streams: [{ codec_name: "h264", codec_type: "video", disposition: { attached_pic: 0 } }],
    });
    // Zero would pass every "shorter than the ceiling" test ever written.
    expect(probe?.duration).toBeNull();
  });

  it("survives the shapes a broken or hostile file produces", () => {
    expect(parseAvProbe(null)).toBeNull();
    expect(parseAvProbe("not json")).toBeNull();
    expect(parseAvProbe({})).toBeNull();
    expect(parseAvProbe({ format: {}, streams: [] })).toBeNull();
    // A known container carrying nothing we can use is still nothing we can use.
    expect(parseAvProbe({ format: { format_name: "mp3" }, streams: [] })).toBeNull();
    expect(
      parseAvProbe({
        format: { format_name: "mp3", duration: "abc" },
        streams: [{ codec_type: "audio" }],
      })?.duration,
    ).toBeNull();
  });

  it("treats a negative or zero dimension as absent", () => {
    const probe = parseAvProbe({
      format: { format_name: "avi", duration: "5" },
      streams: [
        { codec_name: "mpeg4", codec_type: "video", width: 0, height: -1, disposition: {} },
      ],
    });
    expect(probe?.video?.width).toBeNull();
    expect(probe?.video?.height).toBeNull();
  });
});
