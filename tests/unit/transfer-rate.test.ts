import { describe, expect, it } from "vitest";
import { ETA_MIN_RATE, RateMeter, RATE_MIN_SPAN_MS, RATE_WINDOW_MS } from "@/lib/transfer-rate";

const MB = 1024 * 1024;
/** The user's real uplink: 61 Mb/s, which is 7.63 MB/s before protocol overhead. */
const UPLINK = 7 * MB;

/** Feed the meter a steady transfer, one sample a second, starting at t=0. */
function steady(meter: RateMeter, bytesPerSecond: number, seconds: number): number {
  let at = 0;
  for (let i = 1; i <= seconds; i++) {
    at = i * 1000;
    meter.sample(bytesPerSecond * i, at);
  }
  return at;
}

describe("RateMeter, steady transfer", () => {
  it("reports the true rate once it has enough history", () => {
    const meter = new RateMeter();
    steady(meter, UPLINK, 10);
    expect(meter.current).toBeCloseTo(UPLINK, -3);
    expect(meter.average).toBeCloseTo(UPLINK, -3);
  });

  it("says nothing rather than guessing from a single sample", () => {
    const meter = new RateMeter();
    meter.sample(0, 0);
    expect(meter.current).toBe(0);
    expect(meter.average).toBe(0);
  });

  it("refuses to turn a sub-second span into a rate", () => {
    // One late chunk acknowledgement over 100 ms would otherwise read as 10x
    // the real speed.
    const meter = new RateMeter();
    meter.sample(0, 0);
    meter.sample(50 * MB, RATE_MIN_SPAN_MS - 100);
    expect(meter.current).toBe(0);
  });
});

describe("RateMeter, hidden tab", () => {
  /**
   * The reported bug: the tab goes to the background, the byte counter keeps
   * climbing (XHR progress events are not throttled) but setInterval fires
   * about once a minute. The old EMA decayed to zero and then printed one
   * enormous spike. A window over timestamps cannot do that.
   */
  it("does not invent a spike when sampling resumes after a minute away", () => {
    const meter = new RateMeter();
    let at = steady(meter, UPLINK, 10);

    // 60 s with no tick at all, transfer running the whole time.
    at += 60_000;
    meter.sample(UPLINK * (at / 1000), at);

    expect(meter.current).toBeCloseTo(UPLINK, -3);
    expect(meter.current).toBeLessThan(UPLINK * 1.05);
  });

  it("keeps a truthful average across the gap", () => {
    const meter = new RateMeter();
    let at = steady(meter, UPLINK, 5);
    at += 120_000;
    meter.sample(UPLINK * (at / 1000), at);

    expect(meter.average).toBeCloseTo(UPLINK, -3);
  });

  it("still has two samples to work with after the window is exceeded", () => {
    // Trimming must never leave fewer than two: averaging over the gap is the
    // right answer, reporting "unknown" is not.
    const meter = new RateMeter();
    meter.sample(0, 0);
    meter.sample(UPLINK * 90, RATE_WINDOW_MS * 10);
    expect(meter.current).toBeGreaterThan(0);
  });
});

describe("RateMeter, discontinuities", () => {
  it("never reports a negative rate when a file leaves the queue", () => {
    const meter = new RateMeter();
    let at = steady(meter, UPLINK, 10);

    // A cancelled file takes its bytes out of the total.
    at += 1000;
    meter.sample(20 * MB, at);
    expect(meter.current).toBe(0);

    // ...and the meter picks the new, lower run up cleanly.
    for (let i = 1; i <= 10; i++) {
      at += 1000;
      meter.sample(20 * MB + UPLINK * i, at);
    }
    expect(meter.current).toBeCloseTo(UPLINK, -3);
  });

  it("ignores a timestamp that went backwards", () => {
    const meter = new RateMeter();
    meter.sample(0, 5000);
    meter.sample(10 * MB, 1000);
    expect(meter.current).toBe(0);
  });

  it("reads zero for a stalled transfer instead of holding the last number", () => {
    const meter = new RateMeter();
    steady(meter, UPLINK, 5);
    const frozen = 5 * UPLINK;
    for (let i = 6; i <= 30; i++) meter.sample(frozen, i * 1000);
    expect(meter.current).toBe(0);
  });

  it("forgets everything on reset", () => {
    const meter = new RateMeter();
    steady(meter, UPLINK, 10);
    meter.reset();
    expect(meter.current).toBe(0);
    expect(meter.average).toBe(0);
  });
});

describe("RateMeter.eta", () => {
  it("divides what is left by the observed rate", () => {
    const meter = new RateMeter();
    steady(meter, UPLINK, 10);
    // A 5 GB file at 7 MB/s is a 12 minute transfer; the estimate has to say so
    // rather than rounding it away.
    expect(meter.eta(700 * MB)).toBe(100);
  });

  it("declines to estimate while the transfer is not moving", () => {
    const meter = new RateMeter();
    meter.sample(0, 0);
    meter.sample(ETA_MIN_RATE - 1, 1000);
    expect(meter.eta(100 * MB)).toBeNull();
  });

  it("falls back to the average when the live window has nothing yet", () => {
    const meter = new RateMeter();
    steady(meter, UPLINK, 20);
    // Stall long enough for the window to hold only flat samples: `current` is
    // 0, but the batch average still supports an estimate.
    const frozen = 20 * UPLINK;
    for (let i = 21; i <= 45; i++) meter.sample(frozen, i * 1000);
    expect(meter.current).toBe(0);
    expect(meter.eta(100 * MB)).not.toBeNull();
  });

  it("returns null when there is nothing left to send", () => {
    const meter = new RateMeter();
    steady(meter, UPLINK, 10);
    expect(meter.eta(0)).toBeNull();
  });
});
