import { describe, it, expect } from "vitest";
import { TIMELINE_INTERNALS } from "@/lib/media/timeline";
import { timelinePlan, type TimelinePlan } from "@/lib/media/timeline-preview";

/**
 * The one ffmpeg command the sprite sheet is made of.
 *
 * Pinned as ARGUMENTS rather than exercised as a process, the way
 * POSTER_INTERNALS and the av-targets tests are: spawning ffmpeg belongs in an
 * integration test, while the things that go wrong here are ordering and
 * placement, and both are visible in the array.
 *
 * Four of them are load-bearing and each cost a measurement to find:
 *
 *  1. `-discard nokey` BEFORE `-i`. It is an input option; after `-i` ffmpeg
 *     ignores it for the input and the pass decodes the whole file, which
 *     measured 19.5 s against 1.2 s on the same recording.
 *  2. The container FORCED from the probe's allowlist, never guessed. That is
 *     the guard against a text file that begins `ffconcat version 1.0`, and it
 *     also happens to be why one production upload named `.mkv`, which is really
 *     an MP4, works at all.
 *  3. `tpad` AFTER `fps`. Before it, it clones at the source's frame rate rather
 *     than at the tile rate; after it, a file with a single keyframe costs one
 *     wasted tile instead of one wasted frame per source frame.
 *  4. `tpad` present at all. `fps` stops at the last KEYFRAME, not at the end of
 *     the file. Measured on production without it: a 22 s clip asked for 23
 *     tiles and got 20, a 14 s clip asked for 15 and got 14, a 4K clip asked for
 *     16 and got 15 - black cells the VTT still points at.
 */

const { sheetArgs } = TIMELINE_INTERNALS;

function planFor(duration: number, w = 1920, h = 1080): TimelinePlan {
  const decision = timelinePlan(duration, w, h);
  if (!decision.ok) throw new Error(`refused: ${decision.refusal}`);
  return decision.plan;
}

const argsFor = (duration: number, w = 1920, h = 1080) =>
  sheetArgs("/scratch/av-1/input", "mov", planFor(duration, w, h), "/scratch/av-1/sheet.jpg");

const filterOf = (args: string[]) => args[args.indexOf("-vf") + 1];

describe("the sprite pass", () => {
  it("throws non-keyframes away at the demuxer, before -i", () => {
    const args = argsFor(150);
    const discard = args.indexOf("-discard");
    expect(discard).toBeGreaterThan(-1);
    expect(args[discard + 1]).toBe("nokey");
    expect(discard).toBeLessThan(args.indexOf("-i"));
  });

  it("forces the demuxer the probe approved, and the protocol whitelist with it", () => {
    const args = argsFor(150);
    expect(args[args.indexOf("-f") + 1]).toBe("mov");
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file,pipe");
    expect(args.indexOf("-f")).toBeLessThan(args.indexOf("-i"));
  });

  it("never lets an argument become shell syntax or a second input", () => {
    const args = argsFor(150);
    // One input, one output, and every value is its own array element.
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
    expect(args.at(-1)).toBe("/scratch/av-1/sheet.jpg");
    expect(args.some((a) => a.includes(";") || a.includes("|"))).toBe(false);
  });

  it("samples half a slice in, so no tile is the black frame a video opens on", () => {
    const plan = planFor(30);
    const chain = filterOf(argsFor(30));
    expect(chain).toContain(`start_time=${(plan.interval / 2).toFixed(3)}`);
    expect(chain).toContain(`fps=fps=${(plan.count / plan.duration).toFixed(9)}`);
  });

  it("clones the last picture forward, after the decimation and not before", () => {
    const chain = filterOf(argsFor(30));
    const stages = chain.split(",");
    const fps = stages.findIndex((s) => s.startsWith("fps="));
    const tpad = stages.findIndex((s) => s.startsWith("tpad="));
    const scale = stages.findIndex((s) => s.startsWith("scale="));
    const tile = stages.findIndex((s) => s.startsWith("tile="));

    expect(fps).toBeGreaterThan(-1);
    expect(tpad).toBeGreaterThan(fps);
    expect(scale).toBeGreaterThan(tpad);
    expect(tile).toBeGreaterThan(scale);
    expect(stages[tpad]).toContain("stop_mode=clone");
  });

  it("fits and pads rather than stretching, so a rotated phone video survives", () => {
    // ffprobe reports the CODED size, so a video carrying a rotation matrix is
    // planned as 1920x1080 while ffmpeg's own output is 1080x1920. Scaling to
    // fixed numbers would squash it; fitting and centring letterboxes it.
    const chain = filterOf(argsFor(30));
    expect(chain).toContain("force_original_aspect_ratio=decrease");
    expect(chain).toContain("force_divisible_by=2");
    expect(chain).toMatch(/pad=160:90:/);
  });

  it("lays the tiles out in the grid the plan and the VTT both use", () => {
    for (const duration of [4, 30, 150, 7296.76]) {
      const plan = planFor(duration);
      expect(filterOf(argsFor(duration))).toContain(`tile=${plan.columns}x${plan.rows}`);
    }
  });

  it("carries the tile size the plan settled on, portrait included", () => {
    expect(filterOf(argsFor(30, 1080, 1920))).toContain("scale=90:160:");
    expect(filterOf(argsFor(30, 1440, 1080))).toContain("scale=160:120:");
  });

  it("ends the process at the first sheet, and asks for no sound", () => {
    const args = argsFor(7296.76);
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
    expect(args).toContain("-an");
    expect(args).toContain("-sn");
    expect(args[args.indexOf("-q:v") + 1]).toBe(String(TIMELINE_INTERNALS.TIMELINE_JPEG_QUALITY));
  });

  it("keeps enough precision in the rate that a two hour file does not drift", () => {
    const plan = planFor(7296.76);
    const rate = Number(/fps=fps=([0-9.]+)/.exec(filterOf(argsFor(7296.76)))![1]);
    // The last sample must still land inside the file rather than past its end.
    const lastSample = plan.interval / 2 + (plan.count - 1) / rate;
    expect(lastSample).toBeLessThan(plan.duration);
    expect(Math.abs(lastSample - (plan.duration - plan.interval / 2))).toBeLessThan(0.01);
  });
});

describe("the cache tag", () => {
  it("carries a generation number, so a changed plan cannot serve an old sheet", () => {
    // The `motion` -> `motion2` lesson: a cached artefact outlives the code that
    // made it, and here TWO of them have to agree with each other.
    expect(TIMELINE_INTERNALS.TIMELINE_VARIANT).toMatch(/\d$/);
  });
});
