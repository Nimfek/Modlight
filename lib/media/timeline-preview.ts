/**
 * The policy half of the scrub-bar preview: how many pictures a video gets, how
 * far apart they sit, how big each one is, where it lands on the sheet, and what
 * the WebVTT that indexes them says. Pure - no ffmpeg, no sharp, no storage - so
 * every decision here is a unit test, and so the route can ask "would this row
 * produce one?" without dragging a media engine into its bundle.
 *
 * The engine that acts on these answers is lib/media/timeline.ts.
 *
 * WHAT THE PLAYER EXPECTS, AND WHY THE SHAPE IS NOT OURS TO CHOOSE. media-chrome
 * draws the picture over the scrub bar from a metadata text track labelled
 * `thumbnails` hanging off the media element. Read
 * node_modules/media-chrome/dist/media-store/request-map.js: on a preview
 * request it finds the cue covering that moment, resolves the cue's TEXT as a
 * URL against the track's own src, and pulls `#xywh=x,y,w,h` out of the
 * fragment. So the deliverable is exactly two files - one sprite sheet and one
 * VTT whose cues address rectangles inside it - and the fragment syntax is
 * fixed. Everything below is about what goes in them.
 *
 * WHY ONE SHEET AND NOT ONE PICTURE PER MOMENT. A hundred separate tiles is a
 * hundred requests, made while the pointer is moving. One sheet is one request,
 * and the browser has the whole timeline in memory by the time the second cue is
 * needed.
 *
 * WHY A COUNT THAT SCALES WITH LENGTH RATHER THAN A FIXED ONE. A three second
 * clip and a two hour recording are not the same problem for the READER: one
 * wants half-second detail, the other wants to find a scene. They turned out to
 * be the same problem for the SERVER, which is the measurement that made this
 * feature cheap - see the table in lib/media/timeline.ts. Tiles are nearly free
 * in time (measured on one production file: 20 tiles 536 ms, 120 tiles 641 ms)
 * and linear in BYTES (32 kB against 185 kB), so the count is chosen for the
 * person scrubbing and bounded by what we are willing to send them.
 */

import { mediaKind } from "@/lib/media/mime";
import { AV_MAX_INPUT_BYTES } from "@/lib/media/av-cost";

/**
 * Longest edge of one tile.
 *
 * media-chrome sizes its preview box with `--media-preview-thumbnail-max-width`
 * (180px) / `max-height` (160px) and `min-width` (120px) / `min-height` (80px),
 * and it SCALES the tile to fit: a tile smaller than the minimum is blown up and
 * goes soft. 160 on the long edge lands inside that box at scale 1 for every
 * shape - 160x90 for 16:9, 160x120 for 4:3, 90x160 for a phone recording held
 * upright, 160x160 for a square - so nothing is ever upscaled and nothing is
 * wasted on pixels the box will not show.
 *
 * The BOX is what is fixed, not the tile: fitting a portrait video into a 160x90
 * letterbox would have given it a 51x90 picture inside black bars, which the
 * preview box then stretches 2.4x. Every tile from one file shares one shape, so
 * a single `#xywh` size covers the whole sheet either way.
 */
/**
 * The two URL segments this feature answers on, under the existing media route:
 *
 *   GET /{tag}/{code}/timeline.vtt   the metadata track
 *   GET /{tag}/{code}/timeline.jpg   the sprite sheet the track's cues address
 *
 * They live beside `raw`, `download` and `convert` rather than on a route of
 * their own for the reason `motion=1` is a parameter rather than a route: that
 * handler already carries the published check, the password gate, the
 * view-budget exemption for previews and the cache headers, and a second copy of
 * all of that is where the two drift apart.
 *
 * The extension is part of the action, so the sheet's `Content-Type` is legible
 * from the URL and so the VTT can address the sheet as a plain relative name.
 */
export const TIMELINE_TRACK_ACTION = "timeline.vtt";
export const TIMELINE_SHEET_ACTION = "timeline.jpg";

export const TIMELINE_TILE_BOX = 160;

/** No tile smaller than this on either edge, whatever the aspect ratio claims. */
export const TIMELINE_MIN_TILE_EDGE = 16;

/**
 * How far apart the pictures sit when the length does not force otherwise.
 *
 * One a second. That is roughly the granularity at which scrubbing a screen
 * recording stops feeling like a slideshow, and it is what the densest sources
 * on this deployment can actually supply.
 *
 * The sheet is built from KEYFRAMES, so the number of DISTINCT pictures on it is
 * `min(tiles, keyframes)` and nothing else - verified cell by cell on
 * production, where a 22 s clip with five keyframes produced exactly five
 * distinct tiles out of twenty two. Keyframe rates measured across real uploads
 * run from 0.12 to 2.02 per second, an order of magnitude apart, so ANY fixed
 * interval over-samples some files and under-samples others.
 *
 * One a second is chosen at the dense end on purpose. Over-sampling costs only
 * BYTES on an artefact that is built once and cached, and the ceiling below
 * bounds those; under-sampling throws away detail the file really has, and
 * nothing gets it back. Asking the file first would settle it exactly, and it is
 * not worth it: counting the keyframes IS the pass, so it would double the CPU
 * of the whole feature to save some kilobytes on a subset of files.
 */
export const TIMELINE_INTERVAL_SECONDS = 1;

/**
 * ...and the floor, which exists because the sheet is built from KEYFRAMES.
 *
 * The densest keyframe spacing measured across the 386 production videos is
 * about one every 0.5 s (71 keyframes in 35 s; 31 in 15 s). Nothing on the
 * deployment can supply a picture closer together than that, so sampling finer
 * is guaranteed to hand back the same picture twice - a preview claiming detail
 * it does not have, at full price in bytes.
 */
export const TIMELINE_MIN_INTERVAL_SECONDS = 0.5;

/** Fewest tiles worth making, and the most we are willing to send. */
export const TIMELINE_MIN_TILES = 8;

/**
 * The ceiling, and it is a BYTE budget wearing a count.
 *
 * Measured at 160x90, JPEG q6, on production: 20 tiles 32 kB, 60 tiles 93 kB,
 * 100 tiles 153 kB, and the busiest sheet we produced (a two hour recording,
 * where no two tiles resemble each other) 267 kB. That is inside the range this
 * deployment already accepts for the moving grid tile (247-410 kB) and it is
 * fetched once per video and then cached, so 100 is where it stops.
 *
 * At the ceiling a two hour recording gets one picture every 73 s. That is the
 * honest trade: past this length the preview stops being "what is at this
 * second" and becomes "which part of the recording is this", which is what
 * somebody dragging across two hours is asking anyway.
 */
export const TIMELINE_MAX_TILES = 100;

/**
 * Shortest video that gets a timeline at all - and it is DERIVED, not chosen:
 * the fewest tiles worth making, at the closest spacing the source can supply.
 *
 * Below it the two constants above contradict each other, and the only ways out
 * are both worse than a refusal: fewer than eight pictures is not a timeline,
 * and spacing them closer than the keyframes hands back the same picture twice.
 * A four second clip is also one the person can simply play.
 *
 * It is documentation, not a second gate. `timelinePlan` refuses by asking the
 * keyframe floor directly, and this is the length at which that stops happening;
 * tests/unit/timeline-plan.test.ts pins the two to the same boundary so a change
 * to either constant cannot leave this one describing the old rule.
 */
export const TIMELINE_MIN_SECONDS = TIMELINE_MIN_TILES * TIMELINE_MIN_INTERVAL_SECONDS;

/**
 * Why there is no timeline for this file. One vocabulary, server and client.
 *
 * Deliberately NOT in the `X-Convert-Refused` vocabulary that
 * tests/unit/convert-vocabulary.test.ts guards, and for the reason
 * `X-Motion-Refused` is not either: that vocabulary exists because the download
 * menu turns a refusal into a translated sentence in front of a person. These
 * tokens are read by a player deciding whether to hang a `<track>` on its video,
 * and inventing user-facing copy for a decision no user sees would be words
 * nobody reads and translators have to maintain.
 */
export type TimelineRefusal =
  | "not-video"
  | "too-large"
  | "too-short"
  | "too-many-pixels"
  | "unknown-duration"
  | "unreadable"
  | "no-engine";

/** Everything the sheet and the VTT have to agree about, in one object. */
export interface TimelinePlan {
  /** Length the plan was solved for, seconds. */
  duration: number;
  /** Pictures on the sheet. */
  count: number;
  /** Seconds one picture stands for. `duration / count`. */
  interval: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
}

export type TimelineDecision =
  | { ok: true; plan: TimelinePlan }
  | { ok: false; refusal: TimelineRefusal };

/**
 * Could this row have a timeline, judged from the row alone?
 *
 * No read and no decode, because this is also what a listing endpoint would
 * publish a URL from. Deliberately weaker than the real answer: duration is not
 * a column on `uploads`, so "long enough" cannot be decided here and the track
 * endpoint decides it after the probe. A `<track>` whose src refuses is
 * harmless - the player simply has no cues and shows the time alone - whereas a
 * client that has to fetch the video to find out would download gigabytes.
 */
export function canTimelinePreview(row: {
  mimeType: string | null;
  ext: string | null;
  size: number;
}): boolean {
  if (mediaKind(row.mimeType, row.ext) !== "video") return false;
  return row.size > 0 && row.size <= AV_MAX_INPUT_BYTES;
}

/**
 * One tile's pixel size for a source of these dimensions.
 *
 * Down only. Upscaling a 320x180 clip to 160x90 is free of information and not
 * free of bytes, and `withoutEnlargement` is the rule the still thumbnail path
 * already follows.
 *
 * Both edges are even. ffmpeg's yuv420p chroma planes are half-sized, so an odd
 * edge is either rejected or silently rounded, and a silently rounded tile is
 * one pixel out of step with every `#xywh` the VTT hands the player - which
 * reads as a hairline of the neighbouring picture along one edge of every tile.
 */
export function tileGeometry(
  width: number,
  height: number,
): { tileWidth: number; tileHeight: number } | null {
  if (!(width > 0) || !(height > 0)) return null;

  const scale = Math.min(1, TIMELINE_TILE_BOX / Math.max(width, height));
  const tileWidth = evenEdge(width * scale);
  const tileHeight = evenEdge(height * scale);
  return { tileWidth, tileHeight };
}

function evenEdge(value: number): number {
  const rounded = Math.round(value / 2) * 2;
  return Math.max(TIMELINE_MIN_TILE_EDGE, rounded);
}

/**
 * How many pictures, how far apart, and how they are laid out on the sheet.
 *
 * The keyframe floor is asked FIRST, and it is the whole of the "too short"
 * decision rather than a separate rule beside it: a file that cannot afford
 * eight pictures at half-second spacing is refused, and `TIMELINE_MIN_SECONDS`
 * is the length at which that stops happening. Writing it as two checks - a
 * duration ceiling and then a floor on the count - was how the first draft read,
 * and the second check turned out to be unreachable, which is a rule nobody can
 * ever be wrong about and therefore a rule that is not there.
 *
 * After that the count is simply what we want, clamped by what we will send and
 * by what the source can supply.
 *
 * The grid is as square as the count allows. Squareness is not neatness: the
 * sheet is one JPEG the browser decodes into one bitmap, and a 100x1 strip of
 * 160px tiles is 16000 pixels wide, past the maximum texture size of plenty of
 * hardware, where the picture silently fails to paint.
 */
export function timelinePlan(
  duration: number,
  width: number,
  height: number,
): TimelineDecision {
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, refusal: "unknown-duration" };
  }

  // What the source can supply: pictures no closer together than its keyframes.
  const affordable = Math.floor(duration / TIMELINE_MIN_INTERVAL_SECONDS);
  if (affordable < TIMELINE_MIN_TILES) return { ok: false, refusal: "too-short" };

  const tile = tileGeometry(width, height);
  if (!tile) return { ok: false, refusal: "unreadable" };

  const wanted = Math.round(duration / TIMELINE_INTERVAL_SECONDS);
  const count = Math.min(
    Math.max(wanted, TIMELINE_MIN_TILES),
    TIMELINE_MAX_TILES,
    affordable,
  );

  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);

  return {
    ok: true,
    plan: {
      duration,
      count,
      interval: duration / count,
      columns,
      rows,
      ...tile,
    },
  };
}

/** Pixel size of the finished sheet. The engine and its budget both want it. */
export function sheetSize(plan: TimelinePlan): { width: number; height: number } {
  return {
    width: plan.columns * plan.tileWidth,
    height: plan.rows * plan.tileHeight,
  };
}

/**
 * The moment tile `index` is a picture OF.
 *
 * The CENTRE of the slice it stands for, never its edge. Frame zero of a video
 * is black, a fade or a title card far more often than it is content - the still
 * poster starts a second in for exactly this reason - and the last edge is past
 * the final picture, which is a tile of nothing.
 */
export function tileTime(plan: TimelinePlan, index: number): number {
  return plan.interval * (index + 0.5);
}

/** Where tile `index` sits on the sheet, in pixels. */
export function tileRect(
  plan: TimelinePlan,
  index: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: (index % plan.columns) * plan.tileWidth,
    y: Math.floor(index / plan.columns) * plan.tileHeight,
    width: plan.tileWidth,
    height: plan.tileHeight,
  };
}

/**
 * The metadata track, as WebVTT text.
 *
 * `sheetName` is a RELATIVE name on purpose. media-chrome resolves a cue's text
 * against the track element's own src, so `timeline.jpg` next to
 * `timeline.vtt` is correct wherever the file is served from - the tagged URL,
 * the tagless one, and either of the three hostnames this deployment answers on.
 * An absolute URL would have to pick one of those, and picking the wrong one
 * makes the sheet a cross-origin image fetched by an `<img crossorigin>`, which
 * fails without CORS headers nobody would remember to add.
 *
 * The last cue runs to the end of the file rather than to its own slice, so a
 * pointer at the very last pixel of the bar still lands inside a cue.
 */
export function timelineVtt(plan: TimelinePlan, sheetName = TIMELINE_SHEET_ACTION): string {
  const lines = ["WEBVTT", ""];
  for (let i = 0; i < plan.count; i++) {
    const start = plan.interval * i;
    const end = i === plan.count - 1 ? plan.duration : plan.interval * (i + 1);
    const { x, y, width, height } = tileRect(plan, i);
    lines.push(
      String(i + 1),
      `${vttTime(start)} --> ${vttTime(end)}`,
      `${sheetName}#xywh=${x},${y},${width},${height}`,
      "",
    );
  }
  return lines.join("\n");
}

/**
 * `HH:MM:SS.mmm`, which is the only timestamp shape WebVTT accepts with an hour
 * field. Truncated rather than rounded, so a cue can never begin a millisecond
 * after the cue before it ended and leave a moment with no picture.
 */
export function vttTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}
