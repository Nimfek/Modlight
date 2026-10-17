import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { sharp } from "@/lib/media/sharp-runtime";
import { db } from "@/lib/db";
import { user as users } from "@/lib/db/schema";
import { getSession } from "@/lib/auth-helpers";
import { getStorage } from "@/lib/storage";
import {
  BACKGROUND_MAX_BYTES,
  BACKGROUND_MAX_EDGE,
  backgroundKey,
  isAcceptedBackgroundType,
} from "@/lib/background";
import { THUMBNAIL_TIMEOUT_MS, THUMBNAIL_WEIGHT } from "@/lib/media/transform-cost";
import {
  AbortedError,
  BusyError,
  imageTransforms,
  TimeoutError,
} from "@/lib/media/transform-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Decompression-bomb guard. A 40 kB PNG can declare 100k x 100k pixels, which
 * sharp would happily try to allocate.
 */
const MAX_INPUT_PIXELS = 64_000_000;

/**
 * Set the signed-in account's wallpaper.
 *
 * A route handler rather than a Server Action for one reason: actions are
 * capped at a 1 MB body by default, and images are not. The bytes arrive as the
 * raw request body (no multipart), so there is nothing to parse.
 *
 * The uploaded bytes are never stored. sharp re-encodes to WebP, which is what
 * makes this safe to serve back publicly: it strips EXIF (including GPS, on a
 * photo somebody is about to publish behind their pages), drops any trailing
 * payload smuggled after the image data, and guarantees the served type matches
 * the served bytes.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);

  const type = req.headers.get("content-type");
  if (!isAcceptedBackgroundType(type)) return json({ error: "type" }, 415);

  // Declared length first: refusing before reading is the difference between
  // rejecting a 2 GB body and buffering it in order to reject it.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > BACKGROUND_MAX_BYTES) {
    return json({ error: "too-large" }, 413);
  }

  const input = Buffer.from(await req.arrayBuffer());
  // A body may arrive chunked with no Content-Length, so the real size is
  // checked again once it is in hand.
  if (input.byteLength === 0) return json({ error: "empty" }, 400);
  if (input.byteLength > BACKGROUND_MAX_BYTES) return json({ error: "too-large" }, 413);

  let output: Buffer;
  try {
    // Through the shared limiter like every other libvips call, even though this
    // one needs a session: "expensive media work" is counted in one place or the
    // number of concurrent decodes is not actually bounded by anything.
    output = await imageTransforms.run(
      () =>
        sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
          .timeout({ seconds: Math.ceil(THUMBNAIL_TIMEOUT_MS / 1000) })
          // Before resize, always: sharp drops EXIF on encode, so an image relying
          // on the orientation tag would otherwise come out rotated.
          .rotate()
          .resize({
            width: BACKGROUND_MAX_EDGE,
            height: BACKGROUND_MAX_EDGE,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82 })
          .toBuffer(),
      { weight: THUMBNAIL_WEIGHT, timeoutMs: THUMBNAIL_TIMEOUT_MS, signal: req.signal },
    );
  } catch (err) {
    if (err instanceof BusyError || err instanceof TimeoutError) {
      return json({ error: "busy" }, 503);
    }
    if (err instanceof AbortedError) return new Response(null, { status: 499 });
    // Anything sharp cannot decode is not an image, whatever the header claimed.
    return json({ error: "decode" }, 400);
  }

  const storage = getStorage();
  const key = backgroundKey(session.user.id, randomBytes(8).toString("hex"));
  await storage.write(key, output);

  const [previous] = await db
    .update(users)
    .set({ backgroundKey: key })
    .where(eq(users.id, session.user.id))
    .returning({ old: users.backgroundKey });

  // The row now holds the new key, so `old` is the row as it was before this
  // statement - the file nothing points at any more.
  await discard(previous?.old, key);

  return json({ ok: true, bytes: output.byteLength });
}

/** Remove the wallpaper. */
export async function DELETE(): Promise<Response> {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);

  const [previous] = await db
    .update(users)
    .set({ backgroundKey: null })
    .where(eq(users.id, session.user.id))
    .returning({ old: users.backgroundKey });

  await discard(previous?.old, null);
  return json({ ok: true });
}

/**
 * Delete the file a key used to point at.
 *
 * Never throws: the database is already the source of truth about which
 * wallpaper is current, so a storage backend that refuses the delete has cost
 * us a few hundred kilobytes, not correctness - and failing the request would
 * tell the user their change did not happen when it did.
 */
async function discard(oldKey: string | null | undefined, keep: string | null): Promise<void> {
  if (!oldKey || oldKey === keep) return;
  try {
    await getStorage().delete(oldKey);
  } catch {
    /* orphaned bytes, not a failed setting */
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
