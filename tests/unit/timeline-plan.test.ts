import { describe, it, expect } from "vitest";
import {
  canTimelinePreview,
  sheetSize,
  TIMELINE_MAX_TILES,
  TIMELINE_MIN_INTERVAL_SECONDS,
  TIMELINE_MIN_SECONDS,
  TIMELINE_MIN_TILES,
  TIMELINE_SHEET_ACTION,
  TIMELINE_TILE_BOX,
  tileRect,
  tileTime,
  tileGeometry,
  timelinePlan,
  timelineVtt,
  vttTime,
} from "@/lib/media/timeline-preview";

/**
 * The plan behind the scrub-bar preview.
 *
 * Everything here is arithmetic over a duration and two dimensions, which is why
 * it lives in a module with no ffmpeg in it: the interesting cases are a three
 * second clip and a two hour recording, and neither is a thing to discover on
 * production.
 *
 * Two properties are worth more than the rest and are asserted from several
 * directions:
 *
 *  - THE SHEET AND THE TRACK AGREE. They are produced by different requests,
 *    minutes apart, and a rectangle that is one tile out is a preview that shows
 *    the wrong moment. Every coordinate in the VTT is checked against the same
 *    `tileRect` the sheet's grid is built from, and against the sheet's own
 *    pixel size.
 *  - THE CUES COVER THE FILE WITH NO GAPS. A moment with no cue is a hover with
 *    no picture, which reads as a broken player rather than as a missing tile.
 */

const plan = (duration: number, w = 1920, h = 1080) => {
  const decision = timelinePlan(duration, w, h);
  if (!decision.ok) throw new Error(`refused: ${decision.refusal}`);
  return decision.plan;
};

describe("how many pictures a video gets", () => {
  it("asks for one a second in the middle of the range", () => {
    expect(plan(30).count).toBe(30);
    expect(plan(30).interval).toBeCloseTo(1, 6);
    expect(plan(90).count).toBe(90);
  });

  it("stops at the ceiling, and the spacing opens up instead", () => {
    // The longest real video on this deployment.
    const long = plan(475.17);
    expect(long.count).toBe(TIMELINE_MAX_TILES);
    expect(long.interval).toBeCloseTo(4.75, 2);

    // Two hours. One picture every 73 s: past this length the question stops
    // being "what is at this second" and becomes "which part is this".
    const veryLong = plan(7296.76);
    expect(veryLong.count).toBe(TIMELINE_MAX_TILES);
    expect(veryLong.interval).toBeCloseTo(72.97, 1);
  });

  it("never spaces pictures closer than the keyframes can supply them", () => {
    // A five second clip wants five at one a second, gets the floor of eight,
    // and eight is exactly what 0.5 s spacing allows.
    const short = plan(5);
    expect(short.count).toBe(TIMELINE_MIN_TILES);
    expect(short.interval).toBeGreaterThanOrEqual(TIMELINE_MIN_INTERVAL_SECONDS);

    // Swept, not sampled at the two ends: the floor and the minimum count pull
    // in opposite directions and only collide just above the refusal boundary.
    for (let d = TIMELINE_MIN_SECONDS; d <= 300; d += 0.1) {
      expect(plan(d).interval).toBeGreaterThanOrEqual(TIMELINE_MIN_INTERVAL_SECONDS - 1e-9);
    }
  });

  it("refuses a clip too short for eight pictures at that spacing", () => {
    expect(TIMELINE_MIN_SECONDS).toBe(TIMELINE_MIN_TILES * TIMELINE_MIN_INTERVAL_SECONDS);

    const tooShort = timelinePlan(3, 1920, 1080);
    expect(tooShort).toEqual({ ok: false, refusal: "too-short" });

    // The documented length and the rule that actually refuses have to be the
    // same boundary. `TIMELINE_MIN_SECONDS` is prose about the keyframe floor,
    // and prose drifts: the first draft of this module enforced it separately
    // and the second check turned out to be unreachable.
    expect(timelinePlan(TIMELINE_MIN_SECONDS - 0.001, 1920, 1080).ok).toBe(false);
    const atTheLimit = plan(TIMELINE_MIN_SECONDS);
    expect(atTheLimit.count).toBe(TIMELINE_MIN_TILES);
    expect(atTheLimit.interval).toBeCloseTo(TIMELINE_MIN_INTERVAL_SECONDS, 9);
  });

  it("treats a length it cannot read as unknown, not as zero", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(timelinePlan(bad, 1920, 1080)).toEqual({
        ok: false,
        refusal: "unknown-duration",
      });
    }
  });

  it("keeps the count and the interval consistent at every scale", () => {
    for (const d of [4, 7, 13.6, 27.1, 60, 90.1, 150, 293.5, 475.2, 3600, 7296.8]) {
      const p = plan(d);
      expect(p.count).toBeGreaterThanOrEqual(TIMELINE_MIN_TILES);
      expect(p.count).toBeLessThanOrEqual(TIMELINE_MAX_TILES);
      expect(p.interval * p.count).toBeCloseTo(d, 6);
    }
  });
});

describe("one tile", () => {
  it("puts the long edge on the box, whichever edge that is", () => {
    expect(tileGeometry(1920, 1080)).toEqual({ tileWidth: 160, tileHeight: 90 });
    expect(tileGeometry(3840, 2160)).toEqual({ tileWidth: 160, tileHeight: 90 });
    expect(tileGeometry(1440, 1080)).toEqual({ tileWidth: 160, tileHeight: 120 });
    expect(tileGeometry(1080, 1080)).toEqual({ tileWidth: 160, tileHeight: 160 });
    // A phone recording held upright. Fitting it into a 160x90 letterbox would
    // have handed the preview box a 51x90 picture to blow up 2.4 times.
    expect(tileGeometry(1080, 1920)).toEqual({ tileWidth: 90, tileHeight: 160 });
  });

  it("never enlarges a picture that is already smaller than the box", () => {
    expect(tileGeometry(48, 96)).toEqual({ tileWidth: 48, tileHeight: 96 });
    expect(tileGeometry(120, 68)).toEqual({ tileWidth: 120, tileHeight: 68 });
  });

  it("keeps both edges even, so the chroma planes and the rectangles agree", () => {
    for (const [w, h] of [
      [1920, 1078],
      [1920, 1088],
      [1195, 1169],
      [1654, 762],
      [333, 777],
      [101, 99],
    ]) {
      const tile = tileGeometry(w, h)!;
      expect(tile.tileWidth % 2).toBe(0);
      expect(tile.tileHeight % 2).toBe(0);
      expect(Math.max(tile.tileWidth, tile.tileHeight)).toBeLessThanOrEqual(TIMELINE_TILE_BOX);
    }
  });

  it("has nothing to say about a source with no dimensions", () => {
    expect(tileGeometry(0, 1080)).toBeNull();
    expect(tileGeometry(1920, 0)).toBeNull();
    expect(timelinePlan(30, 0, 0)).toEqual({ ok: false, refusal: "unreadable" });
  });
});

describe("the sheet's grid", () => {
  it("stays as square as the count allows", () => {
    for (const d of [4, 20, 60, 150, 7296.8]) {
      const p = plan(d);
      expect(p.columns * p.rows).toBeGreaterThanOrEqual(p.count);
      // One row narrower would not fit; that is what "as square as it gets" means.
      expect((p.columns - 1) * p.rows).toBeLessThan(p.count);
    }
  });

  it("never lays the tiles out in a strip wider than hardware will paint", () => {
    // A 100x1 strip of 160px tiles is 16000 pixels across, past the maximum
    // texture size of plenty of GPUs, where the picture silently fails.
    for (const d of [30, 150, 7296.8]) {
      const { width, height } = sheetSize(plan(d, 1080, 1080));
      expect(width).toBeLessThanOrEqual(4096);
      expect(height).toBeLessThanOrEqual(4096);
    }
  });

  it("puts every tile inside the sheet, with no two on the same rectangle", () => {
    const p = plan(150);
    const { width, height } = sheetSize(p);
    const seen = new Set<string>();
    for (let i = 0; i < p.count; i++) {
      const r = tileRect(p, i);
      expect(r.x + r.width).toBeLessThanOrEqual(width);
      expect(r.y + r.height).toBeLessThanOrEqual(height);
      seen.add(`${r.x},${r.y}`);
    }
    expect(seen.size).toBe(p.count);
  });
});

describe("which moment a tile is a picture of", () => {
  it("samples the middle of the slice, never its edge", () => {
    const p = plan(30);
    expect(tileTime(p, 0)).toBeCloseTo(0.5, 6);
    expect(tileTime(p, p.count - 1)).toBeCloseTo(29.5, 6);
    // Frame zero is black, a fade or a title card far more often than content,
    // and the far edge is past the last picture.
    expect(tileTime(p, 0)).toBeGreaterThan(0);
    expect(tileTime(p, p.count - 1)).toBeLessThan(p.duration);
  });
});

describe("the WebVTT the player reads", () => {
  it("is the shape media-chrome parses", () => {
    const p = plan(30);
    const vtt = timelineVtt(p);
    const lines = vtt.split("\n");

    expect(lines[0]).toBe("WEBVTT");
    expect(lines[1]).toBe("");
    // media-chrome resolves the cue TEXT as a URL against the track's own src
    // and pulls "#xywh=x,y,w,h" out of the fragment - see
    // node_modules/media-chrome/dist/media-store/request-map.js. A relative name
    // is what keeps the sheet same-origin on all three hostnames.
    expect(lines[4]).toBe(`${TIMELINE_SHEET_ACTION}#xywh=0,0,160,90`);
    expect(vtt).not.toContain("http");
  });

  it("gives every tile a cue whose rectangle is the tile's own", () => {
    const p = plan(150);
    const cues = parseCues(timelineVtt(p));
    expect(cues).toHaveLength(p.count);

    cues.forEach((cue, i) => {
      const r = tileRect(p, i);
      expect(cue.payload).toBe(
        `${TIMELINE_SHEET_ACTION}#xywh=${r.x},${r.y},${r.width},${r.height}`,
      );
      // ...and the moment the tile is a picture of falls inside its own cue.
      expect(tileTime(p, i)).toBeGreaterThanOrEqual(cue.start);
      expect(tileTime(p, i)).toBeLessThanOrEqual(cue.end);
    });
  });

  it("covers the file end to end with no gap and no overlap", () => {
    for (const d of [4, 13.6, 150, 7296.76]) {
      const p = plan(d);
      const cues = parseCues(timelineVtt(p));
      expect(cues[0].start).toBe(0);
      for (let i = 1; i < cues.length; i++) {
        expect(cues[i].start).toBe(cues[i - 1].end);
      }
      // The last cue runs to the end of the file rather than to its own slice,
      // so a pointer on the very last pixel of the bar still lands in a cue.
      expect(cues.at(-1)!.end).toBeGreaterThanOrEqual(Math.floor(d * 1000) / 1000 - 0.001);
    }
  });

  it("writes hours out in full, and truncates rather than rounds", () => {
    expect(vttTime(0)).toBe("00:00:00.000");
    expect(vttTime(1.5)).toBe("00:00:01.500");
    expect(vttTime(61.25)).toBe("00:01:01.250");
    expect(vttTime(7296.756)).toBe("02:01:36.756");
    // Rounding up here would let a cue begin a millisecond after the one before
    // it ended, and leave a moment with no picture at all.
    expect(vttTime(1.0009)).toBe("00:00:01.000");
    expect(vttTime(-5)).toBe("00:00:00.000");
  });
});

describe("which rows are even offered one", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    mimeType: "video/mp4",
    ext: "mp4",
    size: 50_000_000,
    ...over,
  });

  it("takes video and nothing else", () => {
    expect(canTimelinePreview(row())).toBe(true);
    expect(canTimelinePreview(row({ mimeType: "image/gif", ext: "gif" }))).toBe(false);
    expect(canTimelinePreview(row({ mimeType: "audio/mpeg", ext: "mp3" }))).toBe(false);
    expect(canTimelinePreview(row({ mimeType: "application/pdf", ext: "pdf" }))).toBe(false);
  });

  it("still recognises a video a client failed to name", () => {
    // The Round 7 lesson: ShareX reads the type out of the Windows registry and
    // sends octet-stream for anything the registry does not know.
    expect(canTimelinePreview(row({ mimeType: "application/octet-stream" }))).toBe(true);
  });

  it("refuses what the engine will refuse anyway", () => {
    expect(canTimelinePreview(row({ size: 0 }))).toBe(false);
    expect(canTimelinePreview(row({ size: 600 * 1024 * 1024 }))).toBe(false);
  });
});

interface Cue {
  start: number;
  end: number;
  payload: string;
}

/** A deliberately literal WebVTT reader: it should fail if the shape drifts. */
function parseCues(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const lines = vtt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})$/.exec(lines[i]);
    if (!m) continue;
    cues.push({ start: toSeconds(m[1]), end: toSeconds(m[2]), payload: lines[i + 1] });
  }
  return cues;
}

function toSeconds(stamp: string): number {
  const [h, m, rest] = stamp.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(rest);
}
