/**
 * Can libvips open this, and how big is it really?
 *
 * Split out of convert.ts so the thumbnail and metadata paths can share it. They
 * used to open buffers with a bare `sharp(buf)` and therefore inherited none of
 * the things this function knows: the `avis` brand workaround, the difference
 * between a frame and a stacked strip, and the fact that "libvips cannot read
 * this" is an answer rather than a crash.
 */

import type { Metadata } from "sharp";
import { sharp } from "@/lib/media/sharp-runtime";
import { withStillAvifBrand } from "@/lib/media/avif-brand";

export interface ImageProbe {
  /** The buffer to hand sharp - possibly a patched copy, see avif-brand.ts. */
  input: Buffer;
  width: number;
  /** Height of ONE frame (sharp's `pageHeight`), not of the stacked strip. */
  height: number;
  pages: number;
  animated: boolean;
  /** Pixels in one frame, and in the whole sequence. */
  framePixels: number;
  totalPixels: number;
  /**
   * True when only the cover frame is reachable, so no target can keep the
   * animation however capable the encoder is.
   */
  coverOnly: boolean;
}

async function readMetadata(buf: Buffer): Promise<Metadata | null> {
  try {
    return await sharp(buf, { failOn: "none", limitInputPixels: false }).metadata();
  } catch {
    return null;
  }
}

/**
 * Returns null when libvips cannot decode the file. Callers answer 415 with
 * that, rather than the catch-all 500 a thrown encoder produces: "we cannot
 * convert this format" is a fact the user can act on, "conversion failed" is not.
 */
export async function probeImage(buf: Buffer): Promise<ImageProbe | null> {
  let input = buf;
  let coverOnly = false;
  let meta = await readMetadata(buf);

  if (!meta) {
    const patched = withStillAvifBrand(buf);
    const patchedMeta = patched ? await readMetadata(patched) : null;
    if (patched && patchedMeta) {
      input = patched;
      meta = patchedMeta;
      coverOnly = true;
    }
  }

  if (!meta?.width || !meta.height) return null;

  const pages = meta.pages && meta.pages > 0 ? meta.pages : 1;
  const height = meta.pageHeight ?? meta.height;
  const framePixels = meta.width * height;

  return {
    input,
    width: meta.width,
    height,
    pages,
    animated: pages > 1 && !coverOnly,
    framePixels,
    totalPixels: framePixels * pages,
    coverOnly,
  };
}
