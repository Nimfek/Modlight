/**
 * Turn whatever the user handed us into the square we are willing to serve.
 *
 * One function, two entry points: the raw-body route (a file from their disk)
 * and the server action (one of their own uploads). Both arrive as a Buffer and
 * both leave as a small WebP, so there is exactly one set of budgets, one
 * encoder and one place where "this is not an image" is decided.
 *
 * The bytes the user supplied are NEVER stored. Re-encoding is what makes an
 * avatar safe to serve publicly: libvips strips EXIF (including the GPS tag on
 * a photo somebody is about to put next to their name), drops any payload
 * smuggled after the image data, and guarantees the served type matches the
 * served bytes.
 */

import { sharp } from "@/lib/media/sharp-runtime";
import { probeImage } from "@/lib/media/probe";
import {
  AVATAR_MAX_FRAME_PIXELS,
  AVATAR_MAX_OUTPUT_BYTES,
  AVATAR_MAX_TOTAL_PIXELS,
  AVATAR_SIZE,
  planAvatar,
} from "@/lib/avatar";
import { THUMBNAIL_TIMEOUT_MS } from "@/lib/media/transform-cost";

/**
 * Why an animated source came out still. Null when nothing was lost - either the
 * source was already a still, or the animation survived.
 *
 * Reported all the way to the toast on purpose. Round 12's lesson was that a
 * refusal the user cannot see reads as a bug in the app: "your GIF was saved as
 * a still because it has 400 frames" is actionable, a silently frozen avatar is
 * a mystery.
 */
export type AvatarDegradation = "frames" | "pixels" | "output-size";

export type AvatarEncodeResult =
  | {
      ok: true;
      bytes: Buffer;
      animated: boolean;
      frames: number;
      degraded: AvatarDegradation | null;
    }
  | { ok: false; error: "decode" | "too-many-pixels" };

/**
 * Encode one avatar. Runs inside the caller's limiter slot; never acquires one
 * itself, so the two entry points can price this alongside their own work.
 *
 * Returns a result rather than throwing for the two conditions the caller has a
 * specific answer for. Anything else (libvips falling over mid-encode) throws
 * and the route answers 500, which is honest: we do not know what happened.
 */
export async function encodeAvatar(input: Buffer): Promise<AvatarEncodeResult> {
  // Metadata only - no decode. `probeImage` is the shared reader, so the `avis`
  // brand workaround and the frame-versus-stacked-strip distinction apply here
  // for free rather than being reimplemented slightly differently.
  const probe = await probeImage(input);
  if (!probe) return { ok: false, error: "decode" };

  const plan = planAvatar({ width: probe.width, height: probe.height, pages: probe.pages });
  if (!plan.ok) return { ok: false, error: "too-many-pixels" };

  const seconds = Math.max(1, Math.ceil(THUMBNAIL_TIMEOUT_MS / 1000));

  /**
   * Edge of the square we produce: the stored size, or the source's own short
   * side when that is smaller.
   *
   * Derived rather than passed straight to `resize(AVATAR_SIZE, AVATAR_SIZE)`
   * with `withoutEnlargement`, because MEASURED: that combination abandons the
   * crop entirely once both source dimensions are under the target - a 60x40 GIF
   * came out 60x40 rather than square. Choosing the edge from the source keeps
   * the cover crop honest at every size and still never upscales, since the edge
   * can never exceed either dimension.
   */
  const edge = Math.max(1, Math.min(AVATAR_SIZE, probe.width, probe.height));

  const encode = async (animated: boolean): Promise<Buffer> => {
    let pipe = sharp(probe.input, {
      failOn: "none",
      animated,
      // Measured: with `animated: true` libvips counts the WHOLE strip against
      // this, so the frame-aware budget is enforced by the decoder as well as by
      // planAvatar. On the still path only page 0 is loaded, so the per-frame
      // bomb guard is the right number there.
      limitInputPixels: animated ? AVATAR_MAX_TOTAL_PIXELS : AVATAR_MAX_FRAME_PIXELS,
    }).timeout({ seconds });

    // EXIF orientation exists on stills (phone photos) and is meaningless on the
    // animated formats. Kept off the animated pipeline anyway: a rotation there
    // would have to be applied to a multi-page strip, and there is no real file
    // that needs it.
    if (!animated) pipe = pipe.rotate();

    return pipe
      .resize(edge, edge, {
        fit: "cover",
        // Measured: "attention" throws `Resize strategy is not supported for
        // multi-page images`. A face is centred in an avatar anyway; the smart
        // crop is only worth having on the still path.
        position: animated ? "centre" : "attention",
      })
      .webp({ quality: animated ? 60 : 82, effort: 4 })
      .toBuffer();
  };

  let bytes = await encode(plan.animate);
  let animated = plan.animate;
  let degraded: AvatarDegradation | null =
    plan.reason === "frames" || plan.reason === "pixels" ? plan.reason : null;

  // The frame budget bounds the ENCODE; this bounds the RESULT, which is the
  // only number the viewer feels. A busy 120-frame sequence can clear every
  // pixel ceiling and still come out fat, and this file is fetched on every page
  // of the panel plus every public page its owner owns.
  if (animated && bytes.byteLength > AVATAR_MAX_OUTPUT_BYTES) {
    bytes = await encode(false);
    animated = false;
    degraded = "output-size";
  }

  return { ok: true, bytes, animated, frames: animated ? plan.frames : 1, degraded };
}
