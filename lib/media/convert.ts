import { PDFDocument } from "pdf-lib";
import type { Sharp } from "sharp";
import { sharp } from "@/lib/media/sharp-runtime";
import { keepsAnimation, type ConvertTarget } from "@/lib/media/convert-targets";
import { maxPixelsFor, peakBytesFor } from "@/lib/media/transform-cost";
import type { ImageProbe } from "@/lib/media/probe";

export type { ConvertTarget, ConvertOption, Motion } from "@/lib/media/convert-targets";
export {
  IMAGE_TARGETS,
  isConvertTarget,
  convertTargetsFor,
  convertOptionFor,
  canConvert,
  keepsAnimation,
} from "@/lib/media/convert-targets";
export { probeImage, type ImageProbe } from "@/lib/media/probe";

export interface Converted {
  buffer: Buffer;
  mime: string;
  ext: string;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export type BudgetVerdict =
  | { ok: true; animated: boolean; pixels: number; limit: number; peakBytes: number }
  | { ok: false; animated: boolean; pixels: number; limit: number; peakBytes: number };

/**
 * Decide whether this conversion may run, and whether it runs frame by frame.
 *
 * Two things it has to get right, both of them past bugs:
 *
 *  - pixels are counted per FRAME when the animation is being kept. The old
 *    guard measured one frame, so a 1654x762 GIF with 256 frames read as
 *    1.26 Mpx and sailed through a 64 Mpx budget while actually costing 322;
 *  - the ceiling comes from the TARGET, not from a single number for all of
 *    them. 64 Mpx of PNG is 384 MB and 2.7 s; 64 Mpx of AVIF would be 2.6 GB
 *    inside a 2 GiB container. See lib/media/transform-cost.ts for the
 *    measurements behind each number.
 *
 * Pure over a probe, so the interesting cases are unit tests rather than
 * production incidents.
 */
export function conversionBudget(
  probe: Pick<ImageProbe, "animated" | "framePixels" | "totalPixels">,
  to: ConvertTarget,
): BudgetVerdict {
  const animated = probe.animated && keepsAnimation(to);
  const pixels = animated ? probe.totalPixels : probe.framePixels;
  const limit = maxPixelsFor(to, animated);
  const peakBytes = peakBytesFor(to, animated, pixels);
  return { ok: pixels <= limit, animated, pixels, limit, peakBytes };
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export interface ConvertOptions {
  /** Must come from `conversionBudget`, never from a guess. */
  animated?: boolean;
  /**
   * Asked of libvips, and of us between stages.
   *
   * libvips honours it only where it evaluates progressively - measured: an
   * animated WebP encode aborts on time, a single-frame AVIF encode does not,
   * because that encoder never returns to the progress callback. So this is a
   * best-effort brake, and the pixel budget is the real bound.
   */
  timeoutMs?: number;
  /** The caller's signal. Checked at every stage boundary. */
  signal?: AbortSignal;
}

/** Throws whatever aborted us, so the route can tell 499 from 503. */
function checkAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Transform aborted");
}

function withDeadline(pipeline: Sharp, timeoutMs: number | undefined): Sharp {
  if (!timeoutMs) return pipeline;
  return pipeline.timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1000)) });
}

/**
 * Convert an image buffer to another image format, or wrap it in a PDF.
 *
 * `animated` must come from `conversionBudget`: passing it for a target that
 * cannot hold motion produces a giant sprite sheet (a 135-frame GIF becomes a
 * 640x86400 PNG), which is how "download as PNG" turns into a 20 MB surprise.
 */
export async function convertImageBuffer(
  input: Buffer,
  to: ConvertTarget,
  opts: ConvertOptions = {},
): Promise<Converted> {
  checkAborted(opts.signal);
  const animated = !!opts.animated && keepsAnimation(to);
  if (to === "pdf") return imageToPdf(input, opts);

  const img = withDeadline(
    animated
      ? // .rotate() is refused for multi-page input, and an animation has no EXIF
        // orientation to bake in anyway.
        sharp(input, { failOn: "none", animated: true })
      : sharp(input, { failOn: "none" }).rotate(), // bake EXIF orientation
    opts.timeoutMs,
  );

  switch (to) {
    case "png":
      return { buffer: await img.png().toBuffer(), mime: "image/png", ext: "png" };
    case "jpg":
      return { buffer: await img.jpeg({ quality: 90 }).toBuffer(), mime: "image/jpeg", ext: "jpg" };
    case "webp":
      return {
        buffer: await img.webp({ quality: animated ? 80 : 90, effort: 4 }).toBuffer(),
        mime: "image/webp",
        ext: "webp",
      };
    case "avif":
      return {
        // Effort 2, not 4. Measured on 12 Mpx of incompressible noise: effort 4
        // takes 22.5 s, effort 2 takes 4.6 s, and the output is 2% larger. On an
        // endpoint anyone with a public link can call, five seconds of a
        // two-core container for a 2% smaller file is not a trade worth making.
        buffer: await img.avif({ quality: 60, effort: 2 }).toBuffer(),
        mime: "image/avif",
        ext: "avif",
      };
  }
}

/**
 * Wrap one picture in a one-page PDF.
 *
 * Via JPEG, not PNG, and that is the whole point of this function.
 *
 * pdf-lib 1.17.1 embeds a PNG by DECODING it with @pdf-lib/upng and re-deflating
 * the samples with pako - both pure, synchronous JavaScript on the main thread.
 * Measured at the 64 Mpx the old budget permitted: 9.4 s wall, of which 7.6 s
 * was the event loop of the ENTIRE application blocked solid (1.0 s in the UPNG
 * decode, 6.5 s in the deflate), and 1433 MB of RSS inside a 2 GiB container.
 * One request, and every other page on the box stops.
 *
 * `embedJpg` does none of that. It parses the JPEG's SOF header for dimensions
 * and hands the bytes to the PDF verbatim under `Filter: DCTDecode` - the format
 * PDF has understood since 1.2. The same 64 Mpx picture now costs 0.96 s wall,
 * 54 ms of worst-case block (the writer, which yields between objects anyway)
 * and 623 MB, with the expensive half running inside libvips, off-thread.
 *
 * What it costs: the page is JPEG, so it is lossy, and transparency is flattened
 * onto white. A PDF page is a sheet of paper - white is what alpha means there -
 * and 4:4:4 chroma keeps screenshot text from fringing, which is the one thing
 * JPEG usually gets wrong for this kind of upload.
 */
async function imageToPdf(input: Buffer, opts: ConvertOptions): Promise<Converted> {
  // Never animated: a PDF page holds one picture, so this is frame one by design.
  const { data, info } = await withDeadline(
    sharp(input, { failOn: "none" }).rotate().flatten({ background: "#ffffff" }),
    opts.timeoutMs,
  )
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
    .toBuffer({ resolveWithObject: true });

  checkAborted(opts.signal);

  const pdf = await PDFDocument.create();
  // A fresh Uint8Array at offset 0: pdf-lib reads the JPEG header through
  // `new DataView(bytes.buffer)` and ignores byteOffset, so a pooled Buffer view
  // would be parsed from the wrong place.
  const embedded = await pdf.embedJpg(new Uint8Array(data));
  const page = pdf.addPage([info.width, info.height]);
  page.drawImage(embedded, { x: 0, y: 0, width: info.width, height: info.height });
  const bytes = await pdf.save();
  return { buffer: Buffer.from(bytes), mime: "application/pdf", ext: "pdf" };
}
