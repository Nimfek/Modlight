import { encode } from "blurhash";
import { sharp } from "@/lib/media/sharp-runtime";
import { probeImage } from "@/lib/media/probe";

export interface ImageMeta {
  width?: number;
  height?: number;
  blurhash?: string;
  /**
   * Frames in the file (1 for a still).
   *
   * Stored on the row so the "download as…" menu can describe THIS file instead
   * of guessing from its container: a still WebP is not "possibly animated", and
   * telling its owner that PNG will give them "a single frame" is a warning
   * about a problem they do not have.
   */
  frames?: number;
}

/**
 * Best-effort image dimensions, frame count and blurhash placeholder. Never throws.
 *
 * Goes through `probeImage`, which is also what the conversion path uses, so the
 * `avis` brand workaround applies here too. Without it the one AVIF sequence in
 * production converted perfectly and yet had no dimensions, no blurhash and no
 * thumbnail, because this function opened the buffer with a plain `sharp()` that
 * libvips refuses on the major brand alone.
 */
export async function imageMetaFromBuffer(buf: Buffer): Promise<ImageMeta> {
  const probe = await probeImage(buf);
  if (!probe) return {};

  let blurhash: string | undefined;
  try {
    const { data, info } = await sharp(probe.input, { failOn: "none" })
      .rotate() // bake EXIF orientation before sampling
      .raw()
      .ensureAlpha()
      .resize(32, 32, { fit: "inside" })
      .toBuffer({ resolveWithObject: true });
    blurhash = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 4);
  } catch {
    /* ignore blurhash failures */
  }

  return {
    width: probe.width,
    height: probe.height,
    // `coverOnly` is set in exactly one situation: an AVIF SEQUENCE whose frames
    // libvips refuses to enumerate, reachable only through the brand-swap
    // workaround that yields its cover. Recording 1 there was true of libvips
    // and false of the file, and it stopped mattering the moment ffmpeg arrived:
    // ffmpeg reads all 43 frames of exactly this file, so a hard 1 would hide
    // the only conversion capable of reading it.
    //
    // Undefined here becomes NULL in the column, which is the established word
    // for "unknown" (every legacy row carries it), and unknown is the honest
    // answer - it leaves the
    // frame-reading targets on the menu instead of ruling them out on the
    // strength of a number we did not measure.
    frames: probe.coverOnly ? undefined : probe.pages,
    blurhash,
  };
}

/**
 * Generate a thumbnail (defaults to a cover crop) as WebP. EXIF is stripped by
 * sharp's default; .rotate() bakes orientation first so portraits aren't sideways.
 */
export async function makeThumbnail(
  input: Buffer,
  opts: {
    width?: number;
    height?: number;
    fit?: "cover" | "inside";
    format?: "webp" | "avif";
    /** Asked of libvips. Honoured here: a resize evaluates progressively. */
    timeoutMs?: number;
  } = {},
): Promise<Buffer> {
  const { width, height, fit = "cover", format = "webp", timeoutMs } = opts;
  let pipe = sharp(input, { failOn: "none" });
  if (timeoutMs) pipe = pipe.timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1000)) });
  pipe = pipe.rotate().resize(width, height, {
    fit,
    position: "attention",
    withoutEnlargement: true,
  });
  pipe = format === "avif" ? pipe.avif({ quality: 55, effort: 3 }) : pipe.webp({ quality: 80 });
  return pipe.toBuffer();
}
