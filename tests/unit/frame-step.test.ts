import { describe, it, expect } from "vitest";
import {
  DEFAULT_FRAME_SECONDS,
  MAX_FRAME_SECONDS,
  MIN_FRAME_SECONDS,
  MIN_MEASURE_WINDOW_SECONDS,
  frameSecondsFromDecoded,
  frameSecondsFromRow,
  frameStepTarget,
  sitsInFrame,
  usableFrameSeconds,
} from "@/lib/media/frame-step";

/**
 * Frame stepping is a seek by a duration, so every one of these is really the
 * same question: does the press put a DIFFERENT picture on the screen? A step
 * that lands inside the frame already showing repaints it and the key reads as
 * broken, which is the failure worth testing rather than the arithmetic.
 *
 * "Which frame is showing at time t" is floor(t / frameSeconds) for a
 * constant-rate file, which is what everything on this deployment is.
 */
const frameAt = (time: number, frameSeconds: number) => Math.floor(time / frameSeconds);

/** Rates that actually turn up here: film, PAL, NTSC, phones, screen recorders. */
const REAL_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

describe("the default step", () => {
  it("is longer than one frame at the slowest rate in circulation", () => {
    // 23.976 fps is 41.71 ms. Anything shorter than that would seek inside the
    // frame on screen for every film yt-dlp brings back, and the very first
    // press would look like a dead key. 1/30 (33 ms) is what that mistake
    // looks like, so it is pinned here as well.
    expect(DEFAULT_FRAME_SECONDS).toBeGreaterThan(1 / 23.976);
    expect(1 / 30).toBeLessThan(1 / 23.976);
  });

  it("moves the picture on every rate in circulation, from anywhere in a frame", () => {
    for (const fps of REAL_RATES) {
      const frame = 1 / fps;
      // Start at the beginning of a frame, at its middle, and just before its
      // end: a step has to leave the frame from all three.
      for (const offset of [0, 0.5, 0.99]) {
        const from = 10 * frame + offset * frame;
        const target = frameStepTarget({
          from,
          frameSeconds: DEFAULT_FRAME_SECONDS,
          direction: 1,
          snapped: false,
          duration: 600,
        });
        expect(frameAt(target, frame)).toBeGreaterThan(frameAt(from, frame));
      }
    }
  });

  it("stays frame-scale even where it over-steps", () => {
    // At 60 fps the default covers two and a half frames. That is the accepted
    // half of the trade - it is still frame-scale, and it is corrected the
    // moment the clip plays and a real gap is measured.
    expect(DEFAULT_FRAME_SECONDS / (1 / 60)).toBeLessThan(3);
  });
});

describe("a step measured from the frame on screen", () => {
  it("lands strictly inside the next frame, never on the boundary", () => {
    for (const fps of REAL_RATES) {
      const frame = 1 / fps;
      const start = 40 * frame; // the exact start of a frame, as rVFC reports it
      const forward = frameStepTarget({
        from: start,
        frameSeconds: frame,
        direction: 1,
        snapped: true,
        duration: 600,
      });
      const back = frameStepTarget({
        from: start,
        frameSeconds: frame,
        direction: -1,
        snapped: true,
        duration: 600,
      });
      expect(frameAt(forward, frame)).toBe(41);
      expect(frameAt(back, frame)).toBe(39);
      // Strictly inside: a target sitting on a boundary is decided by a
      // rounding error, and half the time it decides on the frame already up.
      expect(forward).toBeGreaterThan(41 * frame);
      expect(forward).toBeLessThan(42 * frame);
    }
  });

  it("does not drift over a run of presses", () => {
    // Each press is measured from the frame the compositor actually presented,
    // so ten presses are ten frames and not nine or eleven.
    const frame = 1 / 30;
    let showing = 100 * frame;
    for (let i = 0; i < 10; i++) {
      const target = frameStepTarget({
        from: showing,
        frameSeconds: frame,
        direction: 1,
        snapped: true,
        duration: 600,
      });
      // What the browser then presents is the START of the frame containing it.
      showing = frameAt(target, frame) * frame;
    }
    expect(Math.round(showing / frame)).toBe(110);
  });
});

describe("the edges of the file", () => {
  it("never seeks below zero", () => {
    expect(
      frameStepTarget({ from: 0, frameSeconds: 0.04, direction: -1, snapped: false, duration: 10 }),
    ).toBe(0);
  });

  it("stops half a frame short of the end, so the last frame is reachable", () => {
    // Seeking to `duration` is the one seek a browser answers by ending the
    // video, which would make the final frame impossible to step onto.
    const target = frameStepTarget({
      from: 9.99,
      frameSeconds: 0.04,
      direction: 1,
      snapped: false,
      duration: 10,
    });
    expect(target).toBeCloseTo(9.98, 10);
    expect(target).toBeLessThan(10);
  });

  it("does not clamp against a duration the browser has not got yet", () => {
    // NaN duration is what `<video>` reports before metadata lands.
    const target = frameStepTarget({
      from: 5,
      frameSeconds: 0.04,
      direction: 1,
      snapped: false,
      duration: Number.NaN,
    });
    expect(target).toBeCloseTo(5.04, 10);
  });
});

describe("what the row can say about the frame rate", () => {
  it("divides a frame count by the duration", () => {
    expect(frameSecondsFromRow(300, 10)).toBeCloseTo(1 / 30, 10);
  });

  it("says nothing when the row says nothing, or says something impossible", () => {
    expect(frameSecondsFromRow(null, 10)).toBeNull();
    expect(frameSecondsFromRow(undefined, 10)).toBeNull();
    // A single frame is a still, not a rate.
    expect(frameSecondsFromRow(1, 10)).toBeNull();
    expect(frameSecondsFromRow(300, 0)).toBeNull();
    expect(frameSecondsFromRow(300, Number.NaN)).toBeNull();
    // 1000 fps: a broken nb_frames, not a camera.
    expect(frameSecondsFromRow(10_000, 10)).toBeNull();
    // One frame every two seconds: the same, from the other end.
    expect(frameSecondsFromRow(5, 10)).toBeNull();
  });
});

describe("learning the rate from a stretch of playback", () => {
  it("divides media time by the frames the decoder made in it", () => {
    expect(frameSecondsFromDecoded(2, 60)).toBeCloseTo(1 / 30, 10);
    expect(frameSecondsFromDecoded(4, 96)).toBeCloseTo(1 / 24, 10);
    expect(frameSecondsFromDecoded(1.5, 90)).toBeCloseTo(1 / 60, 10);
  });

  it("refuses a window too short to divide by", () => {
    // A quarter second of 30 fps content is 8 frames, and one frame of integer
    // rounding is 12% of the answer. Measured in the browser, quarter-second
    // windows on a 30 fps clip read anywhere from 26.5 to 30.7 fps.
    expect(frameSecondsFromDecoded(0.26, 8)).toBeNull();
    expect(frameSecondsFromDecoded(MIN_MEASURE_WINDOW_SECONDS - 0.001, 30)).toBeNull();
    expect(frameSecondsFromDecoded(MIN_MEASURE_WINDOW_SECONDS, 30)).toBeCloseTo(1 / 30, 10);
  });

  it("refuses a window with nothing in it, and any answer out of band", () => {
    expect(frameSecondsFromDecoded(2, 0)).toBeNull();
    expect(frameSecondsFromDecoded(2, -5)).toBeNull();
    expect(frameSecondsFromDecoded(Number.NaN, 30)).toBeNull();
    // 600 frames in a second: a counter that swallowed a seek's decode.
    expect(frameSecondsFromDecoded(1, 600)).toBeNull();
    // One frame in ten seconds: not a video anybody is stepping through.
    expect(frameSecondsFromDecoded(10, 1)).toBeNull();
  });

  it("is within a few percent at the precision a step needs", () => {
    // The step only has to land inside the neighbouring frame, so it tolerates
    // a third of a frame either way. One second of 30 fps content is off by at
    // most one frame of rounding, which is 3%.
    const truth = 1 / 30;
    for (const frames of [29, 30, 31]) {
      const measured = frameSecondsFromDecoded(1, frames)!;
      expect(Math.abs(measured - truth) / truth).toBeLessThan(0.05);
    }
  });

  it("agrees with the band it is checked against", () => {
    expect(usableFrameSeconds(MIN_FRAME_SECONDS)).toBe(true);
    expect(usableFrameSeconds(MAX_FRAME_SECONDS)).toBe(true);
    expect(usableFrameSeconds(MIN_FRAME_SECONDS / 2)).toBe(false);
    expect(usableFrameSeconds(MAX_FRAME_SECONDS * 2)).toBe(false);
    expect(usableFrameSeconds(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("whether the remembered frame start is still the frame we are on", () => {
  const frame = 1 / 30;

  it("holds while the element is inside that frame", () => {
    expect(sitsInFrame(2.0, 2.0, frame)).toBe(true);
    expect(sitsInFrame(2.0 + frame * 0.9, 2.0, frame)).toBe(true);
  });

  it("fails the moment we are past it - which is what a second press looks like", () => {
    // Press one seeks to the middle of the next frame; the compositor has not
    // presented it yet, so the remembered start still describes the frame we
    // have left. Trusting it would recompute the same target and the second
    // press would do nothing.
    expect(sitsInFrame(2.0 + frame * 1.5, 2.0, frame)).toBe(false);
    // A drag backwards is the other way it goes stale.
    expect(sitsInFrame(1.0, 2.0, frame)).toBe(false);
    expect(sitsInFrame(2.0, null, frame)).toBe(false);
  });

  it("makes the second press of a pair land one frame further on", () => {
    // The property the two rules exist for, end to end.
    const presented = 5.0; // start of the frame on screen
    const first = frameStepTarget({
      from: presented,
      frameSeconds: frame,
      direction: 1,
      snapped: true,
      duration: 60,
    });
    // Nothing has been presented yet, so the remembered start is unchanged.
    const stale = sitsInFrame(first, presented, frame);
    expect(stale).toBe(false);
    const second = frameStepTarget({
      from: first,
      frameSeconds: frame,
      direction: 1,
      snapped: stale,
      duration: 60,
    });
    expect(frameAt(first, frame)).toBe(151);
    expect(frameAt(second, frame)).toBe(152);
  });
});
