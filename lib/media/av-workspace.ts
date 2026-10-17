/**
 * A real path for ffmpeg to read, and a private directory for it to write into.
 *
 * ffmpeg wants files, not buffers - which is a feature here, not a limitation.
 * The image path reads whole uploads into memory and is capped at 32 MB because
 * of it; ffmpeg streams from disk, so a 400 MB video costs the same resident
 * memory as a 4 MB one (measured: 57 MB peak for a 37 MB remux).
 *
 * Two jobs:
 *
 *  1. INPUT. The local driver already has the file on a filesystem, so its path
 *     is handed over as-is - no copy, no temp space, no second read of 400 MB.
 *     Any other driver has to stage a copy, and says so by paying for it.
 *
 *  2. OUTPUT. Every job gets its own directory, and it is removed whatever
 *     happens. This is also a security boundary: ffmpeg writes only inside it,
 *     so a target name can never turn into a path, and a killed process cannot
 *     leave a half-written file where a later request might serve it.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getStorage } from "@/lib/storage";
import { config } from "@/lib/config";

export interface AvWorkspace {
  /** Absolute path ffmpeg reads from. */
  input: string;
  /** Absolute path inside a private directory for ffmpeg to write to. */
  output(name: string): string;
  /** Removes the scratch directory, and the staged input if there was one. */
  dispose(): Promise<void>;
}

/**
 * Where scratch directories go. The uploads temp dir already exists and is ours.
 *
 * The `turbopackIgnore` marker earns its place: Turbopack's tracer reads a path
 * built from a non-literal as evidence of a dynamic require and responds by
 * tracing the WHOLE project into this route's file list ("Encountered unexpected
 * file in NFT list"). Verified by removing it - the warning comes straight back.
 * It changes nothing at runtime; it only stops the static analysis following a
 * path it cannot resolve.
 */
function scratchRoot(): string {
  const configured = config.uploads.tmpPath;
  if (!configured) return tmpdir();
  return isAbsolute(configured)
    ? configured
    : join(/* turbopackIgnore: true */ process.cwd(), configured);
}

/**
 * Open a workspace for one job.
 *
 * `maxBytes` is checked against the object's real size before anything is
 * staged, so an oversized file costs a stat rather than a copy.
 */
export async function openAvWorkspace(
  storageKey: string,
  maxBytes: number,
): Promise<AvWorkspace | { error: "missing" | "too-large"; size?: number }> {
  const storage = getStorage();

  const info = await storage.stat(storageKey);
  if (!info) return { error: "missing" };
  if (info.size > maxBytes) return { error: "too-large", size: info.size };

  // The parent must exist for mkdtemp. The image creates data/tmp in the
  // Dockerfile, but a fresh clone has no data/ at all, and every ffmpeg path
  // (posters, motion previews, timeline sheets) failed there with ENOENT.
  await mkdir(scratchRoot(), { recursive: true });
  const dir = await mkdtemp(join(scratchRoot(), "av-"));
  let staged: string | null = null;

  try {
    let input: string;
    // The bytes may already be on a filesystem ffmpeg can read, in which case
    // copying them would double the I/O of every conversion for no gain. The
    // driver answers that; asking with `instanceof` would put a concrete
    // implementation back in the middle of an abstraction built to avoid it.
    const direct = storage.localPath?.(storageKey) ?? null;
    if (direct) {
      // No existence check here: `storage.stat()` above already returned this
      // object's size, so a second one would re-ask a question we have the
      // answer to. (It also made Turbopack's tracer follow a computed fs path
      // out of this module and trace the entire project into the route's file
      // list.) A row whose bytes vanish between the two would fail at ffprobe,
      // which reports it as an unreadable file.
      input = direct;
    } else {
      staged = join(dir, "input");
      await pipeline(await storage.readStream(storageKey), createWriteStream(staged));
      input = staged;
    }

    return {
      input,
      output: (name: string) => join(dir, sanitizeName(name)),
      async dispose() {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Output names are built from our own target table, never from a request - but
 * the check is cheap and this is the one place a path could be formed, so it is
 * enforced rather than assumed.
 */
function sanitizeName(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(`Refusing unsafe output name: ${name}`);
  }
  return name;
}

/** Stream a finished output file, then drop the workspace it lived in. */
export function readAndDispose(path: string, ws: AvWorkspace): NodeJS.ReadableStream {
  const stream = createReadStream(path);
  const done = () => void ws.dispose();
  stream.once("close", done);
  stream.once("error", done);
  return stream;
}
