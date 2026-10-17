// dotenv must load before anything reads @/lib/config (which snapshots env).
import "dotenv/config";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { mediaKind } from "@/lib/media/mime";
import { frameCount, probeStoredAvMeta, type AvMeta } from "@/lib/media/av-meta";
import { ffmpegAvailable } from "@/lib/media/ffmpeg";
import { effectiveCpuCount } from "@/lib/runtime/limits";

/**
 * scripts/backfill-av-metadata.ts
 * ---------------------------------------------------------------------------
 * Fill width / height / frames / duration / fps for audio and video rows that
 * never got them, using the same `probeStoredAvMeta()` the upload path now runs.
 * One implementation, so a row repaired here is the row a re-upload would make.
 *
 *   pnpm tsx scripts/backfill-av-metadata.ts                  # dry run
 *   pnpm tsx scripts/backfill-av-metadata.ts --apply          # write them
 *   pnpm tsx scripts/backfill-av-metadata.ts --all -v         # every A/V row
 *   pnpm tsx scripts/backfill-av-metadata.ts --limit 20 -v    # try a handful
 *
 * WHY A SIBLING OF scripts/fix-mime-types.ts AND NOT A FLAG ON IT
 *
 * That script answers "what IS this file" from 4 KiB of head bytes, and its
 * one write is documented as impossible to get wrong: it only ever sharpens a
 * type, never downgrades one. This answers a different question with a
 * different engine - ffprobe, a process per file, with its own timeout, its own
 * refusal vocabulary and its own reason to find nothing. Folding it in would
 * also mean that `--apply`, a command the operator has already run against
 * production, quietly acquired 467 process spawns. Separate job, separate
 * command, same four design rules:
 *
 *  1. DRY RUN BY DEFAULT. It touches production rows nobody asked to have
 *     touched, so the write needs an explicit --apply.
 *  2. FILL ONLY. A column is written only where the row holds NULL, so a run
 *     against storage that is temporarily unreachable cannot damage anything,
 *     and re-running after a partial run resumes rather than rewrites.
 *  3. IDEMPOTENT. After a successful run the repaired rows no longer match the
 *     default filter; --all recomputes the same answer and writes nothing.
 *  4. MISSING BYTES ARE A WARNING. A row whose file is gone is reported and
 *     skipped, never an abort: this must be runnable on a live install.
 *
 * COST, measured in the production image (ffmpeg 5.1.9, --cpus 2) over 59 real
 * videos: 136 ms median warm, 158 ms median cold, 120 ms of which is the bare
 * cost of spawning ffprobe. Size barely matters, because a probe seeks and
 * never decodes: the 419 MB file on the box answered in 144 ms warm.
 */

interface Options {
  apply: boolean;
  all: boolean;
  includeTrashed: boolean;
  limit: number | null;
  verbose: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    apply: false,
    all: false,
    includeTrashed: false,
    limit: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--all") opts.all = true;
    else if (arg === "--include-trashed") opts.includeTrashed = true;
    else if (arg === "-v" || arg === "--verbose") opts.verbose = true;
    else if (arg === "--limit") opts.limit = Number(argv[++i]);
    else if (arg.startsWith("--limit=")) opts.limit = Number(arg.slice("--limit=".length));
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      usage();
      process.exit(1);
    }
  }
  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
    console.error("--limit takes a positive number");
    process.exit(1);
  }
  return opts;
}

function usage(): void {
  console.log(
    [
      "usage: tsx scripts/backfill-av-metadata.ts [options]",
      "",
      "  --apply             write the changes (default: dry run)",
      "  --all               examine every audio/video row, not only the blank ones",
      "  --include-trashed   also examine rows in the trash",
      "  --limit N           stop after N rows",
      "  -v, --verbose       print every row, not only the ones that gain something",
    ].join("\n"),
  );
}

/**
 * How many probes run at once.
 *
 * The cgroup's number, not the host's: inside the container those disagree 2 vs
 * 6 (lib/runtime/limits.ts), and a pool sized from `nproc` would put six ffprobe
 * processes on a two-core quota while the panel is serving real traffic. Capped
 * at 4 because most of a probe's 136 ms is process startup rather than CPU, so
 * a little oversubscription helps and a lot does not.
 */
const PROBE_CONCURRENCY = Math.max(1, Math.min(4, effectiveCpuCount()));

/**
 * "Blank" = this row has never been measured at all.
 *
 * Both columns, not just width: an audio file legitimately has no width, so
 * `width IS NULL` alone would re-probe every MP3 on every run forever. A video
 * that yields a duration but no dimensions is likewise finished as far as the
 * default filter is concerned; --all is how you ask again.
 */
const blankFilter = and(isNull(uploads.width), isNull(uploads.durationSeconds));

/** What the row already holds, so a fill can be told from a no-op. */
interface Row {
  id: string;
  storageKey: string;
  ext: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  frames: number | null;
  durationSeconds: number | null;
  fps: number | null;
}

/** The subset of columns this run may write: those the row does not have yet. */
function fillFor(row: Row, meta: AvMeta): Partial<Row> {
  const patch: Partial<Row> = {};
  if (row.width == null && meta.width != null) patch.width = meta.width;
  if (row.height == null && meta.height != null) patch.height = meta.height;
  if (row.frames == null && meta.frames != null) patch.frames = meta.frames;
  if (row.durationSeconds == null && meta.durationSeconds != null) {
    patch.durationSeconds = meta.durationSeconds;
  }
  if (row.fps == null && meta.fps != null) patch.fps = meta.fps;
  return patch;
}

function describe(meta: AvMeta): string {
  const parts: string[] = [];
  if (meta.width && meta.height) parts.push(`${meta.width}x${meta.height}`);
  if (meta.durationSeconds != null) parts.push(`${meta.durationSeconds.toFixed(2)}s`);
  if (meta.fps != null) parts.push(`${Math.round(meta.fps * 100) / 100} fps`);
  const total = frameCount(meta);
  if (total != null) parts.push(`${total} frames${meta.frames == null ? " (est.)" : ""}`);
  return parts.length > 0 ? parts.join(", ") : "nothing measurable";
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log(
    `mode: ${opts.apply ? "APPLY (rows will be written)" : "dry run (nothing is written)"}`,
  );
  console.log(`scope: ${opts.all ? "every audio/video row" : "rows with no measurements yet"}`);
  console.log(`concurrency: ${PROBE_CONCURRENCY}`);

  if (!(await ffmpegAvailable())) {
    console.error(
      "ffprobe is not runnable here, so every row would be skipped. " +
        "Run this inside the app image, or set FFPROBE_PATH.",
    );
    process.exit(1);
  }

  // The type filter is applied in SQL only as a cheap pre-selection, then
  // re-decided in JS with `mediaKind`, which is the predicate the serving layer
  // uses. That matters: a recording whose stored type is still
  // application/octet-stream (what Windows hands ShareX for anything modern -
  // see lib/media/sniff.ts) is a video to every reader and would be invisible to
  // a `mime_type like 'video/%'` query.
  const candidates: Row[] = await db
    .select({
      id: uploads.id,
      storageKey: uploads.storageKey,
      ext: uploads.ext,
      mimeType: uploads.mimeType,
      width: uploads.width,
      height: uploads.height,
      frames: uploads.frames,
      durationSeconds: uploads.durationSeconds,
      fps: uploads.fps,
    })
    .from(uploads)
    .where(
      and(
        opts.includeTrashed ? undefined : isNull(uploads.deletedAt),
        opts.all ? undefined : blankFilter,
        // Anything that could conceivably be audio or video. Deliberately wide;
        // `mediaKind` below is the real test.
        or(
          sql`lower(${uploads.mimeType}) like 'video/%'`,
          sql`lower(${uploads.mimeType}) like 'audio/%'`,
          sql`lower(${uploads.mimeType}) in (
            'application/octet-stream',
            'binary/octet-stream',
            'application/x-download',
            'application/download',
            'application/force-download',
            'application/unknown',
            ''
          )`,
        ),
      ),
    )
    .orderBy(asc(uploads.createdAt));

  const audioVideo = candidates.filter((r) => {
    const kind = mediaKind(r.mimeType, r.ext);
    return kind === "video" || kind === "audio";
  });
  const rows = opts.limit == null ? audioVideo : audioVideo.slice(0, opts.limit);

  console.log(
    `${candidates.length} candidate row(s), ${audioVideo.length} of them audio or video` +
      (rows.length === audioVideo.length ? "\n" : `, examining ${rows.length}\n`),
  );
  if (rows.length === 0) {
    console.log("nothing to do");
    process.exit(0);
  }

  const storage = getStorage();
  const started = Date.now();
  let filled = 0;
  let unchanged = 0;
  let unreadable = 0;
  let missing = 0;
  let withDimensions = 0;

  const queue = [...rows];
  const workers = Array.from({ length: PROBE_CONCURRENCY }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;

      // Asked before the probe purely so a gone file reports as a gone file
      // rather than as "ffprobe found nothing", which would send whoever reads
      // this output looking for a codec problem that does not exist.
      const info = await storage.stat(row.storageKey).catch(() => null);
      if (!info) {
        missing++;
        console.warn(`  ! ${row.storageKey}: bytes unreadable, skipped`);
        continue;
      }

      // stageRemote: this is an offline job, so paying for a copy out of S3 is
      // allowed here in a way it never is on the upload path.
      const meta = await probeStoredAvMeta(row.storageKey, { stageRemote: true });
      if (!meta) {
        unreadable++;
        console.warn(`  ? ${row.storageKey}: ffprobe found no media we accept`);
        continue;
      }
      if (meta.width != null && meta.height != null) withDimensions++;

      const patch = fillFor(row, meta);
      if (Object.keys(patch).length === 0) {
        unchanged++;
        if (opts.verbose) console.log(`  = ${row.storageKey}: ${describe(meta)}`);
        continue;
      }

      filled++;
      console.log(
        `  ${opts.apply ? "+" : "~"} ${row.storageKey}: ${describe(meta)}` +
          ` [${Object.keys(patch).join(", ")}]`,
      );

      if (opts.apply) {
        await db
          .update(uploads)
          .set(patch)
          .where(eq(uploads.id, row.id));
      }
    }
  });
  await Promise.all(workers);

  const elapsed = Date.now() - started;
  console.log("");
  console.log(
    `${filled} row(s) ${opts.apply ? "updated" : "would be updated"}` +
      `, ${unchanged} already complete, ${unreadable} not readable media, ${missing} unreadable bytes`,
  );
  console.log(
    `${withDimensions} of ${rows.length} row(s) yielded picture dimensions` +
      ` (audio files legitimately have none)`,
  );
  console.log(
    `took ${(elapsed / 1000).toFixed(1)} s` +
      ` (${Math.round(elapsed / Math.max(1, rows.length))} ms per row at concurrency ${PROBE_CONCURRENCY})`,
  );

  // `updatedAt` is deliberately NOT touched. These columns describe bytes that
  // have not changed; bumping the row's timestamp would reorder somebody's
  // dashboard and make 467 files look freshly modified for no reason.
  if (!opts.apply && filled > 0) {
    console.log("\nnothing was written. Re-run with --apply to commit.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
