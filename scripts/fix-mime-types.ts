// dotenv must load before anything reads @/lib/config (which snapshots env).
import "dotenv/config";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { uploads } from "@/lib/db/schema";
import { getStorage, readHead } from "@/lib/storage";
import { isSharperType, resolveUploadType } from "@/lib/media/sniff";
import { imageMetaFromBuffer } from "@/lib/media/image";

/**
 * scripts/fix-mime-types.ts
 * ---------------------------------------------------------------------------
 * Repair rows whose stored MIME type is uninformative, using the same
 * `resolveUploadType()` the upload path now runs. One implementation, so a row
 * repaired here is byte-for-byte the row a re-upload would produce.
 *
 *   pnpm tsx scripts/fix-mime-types.ts                 # dry run, suspect rows
 *   pnpm tsx scripts/fix-mime-types.ts --apply         # write them
 *   pnpm tsx scripts/fix-mime-types.ts --all -v        # audit every row
 *   pnpm tsx scripts/fix-mime-types.ts --backfill-dimensions --apply
 *
 * DESIGN RULES
 *
 *  1. DRY RUN BY DEFAULT. The opposite of the importer, and on purpose: this
 *     touches production rows nobody asked to have touched, so the write needs
 *     an explicit --apply.
 *  2. SHARPEN ONLY. A row is updated when the new type carries information the
 *     old one did not (see isSharperType); an X -> octet-stream downgrade is
 *     impossible by construction, so a run over storage that is temporarily
 *     unreachable cannot damage anything.
 *  3. IDEMPOTENT. After a run the repaired rows no longer match "suspect", and
 *     --all recomputes the same answer and writes nothing. Safe to repeat.
 *  4. MISSING BYTES ARE A WARNING. A row whose file is gone is reported and
 *     skipped, never an abort: this must be runnable on a live install.
 */

interface Options {
  apply: boolean;
  all: boolean;
  backfillDimensions: boolean;
  limit: number | null;
  verbose: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    apply: false,
    all: false,
    backfillDimensions: false,
    limit: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--all") opts.all = true;
    else if (arg === "--backfill-dimensions") opts.backfillDimensions = true;
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
      "usage: tsx scripts/fix-mime-types.ts [options]",
      "",
      "  --apply                 write the changes (default: dry run)",
      "  --all                   examine every row, not only the suspect ones",
      "  --backfill-dimensions   also fill width/height/blurhash where missing",
      "  --limit N               stop after N rows",
      "  -v, --verbose           print every row, not only the changes",
    ].join("\n"),
  );
}

/** How many bytes of each file are read. 4 KiB covers every known signature. */
const HEAD_BYTES = 4096;

/** Ceiling for the dimension backfill, which has to decode the whole image. */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;

/** How many dimension backfills run at once. The container has two cores. */
const DECODE_CONCURRENCY = 4;

/**
 * "Suspect" = the stored type carries no information. Rows outside this set are
 * only examined under --all, and even then a disagreement is reported rather
 * than written: a .sxcu stored as application/json is a deliberate choice, and
 * x-msdownload versus vnd.microsoft.portable-executable is cosmetics.
 */
const suspectFilter = or(
  isNull(uploads.mimeType),
  eq(uploads.mimeType, ""),
  sql`lower(${uploads.mimeType}) in (
    'application/octet-stream',
    'binary/octet-stream',
    'application/x-download',
    'application/download',
    'application/force-download',
    'application/unknown'
  )`,
);

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log(
    `mode: ${opts.apply ? "APPLY (rows will be written)" : "dry run (nothing is written)"}`,
  );
  console.log(`scope: ${opts.all ? "every upload" : "uploads with an uninformative type"}`);

  const rows = await db
    .select({
      id: uploads.id,
      code: uploads.code,
      filename: uploads.filename,
      ext: uploads.ext,
      mimeType: uploads.mimeType,
      storageKey: uploads.storageKey,
      size: uploads.size,
    })
    .from(uploads)
    .where(opts.all ? undefined : suspectFilter)
    .orderBy(asc(uploads.createdAt))
    .limit(opts.limit ?? 1_000_000);

  console.log(`examining ${rows.length} row(s)\n`);

  const transitions = new Map<string, number>();
  let changed = 0;
  let missing = 0;
  let reportedOnly = 0;

  for (const row of rows) {
    const head = await readHead(row.storageKey, HEAD_BYTES);
    if (head.length === 0) {
      missing++;
      console.warn(`  ! ${row.storageKey}: bytes unreadable, skipped`);
      continue;
    }

    const resolved = resolveUploadType({
      clientMime: row.mimeType,
      filename: row.filename,
      ext: row.ext,
      head,
    });

    if (resolved === row.mimeType) {
      if (opts.verbose) console.log(`  = ${row.storageKey}: ${row.mimeType}`);
      continue;
    }

    // Outside the suspect set the stored type already says something, so a
    // difference is an observation, not a defect to fix behind the operator's
    // back. isSharperType is what encodes that rule.
    if (!isSharperType(row.mimeType, resolved)) {
      reportedOnly++;
      if (opts.verbose) {
        console.log(`  ? ${row.storageKey}: stored ${row.mimeType}, bytes say ${resolved}`);
      }
      continue;
    }

    const key = `${row.mimeType || "(empty)"} -> ${resolved}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
    changed++;
    console.log(`  ${opts.apply ? "+" : "~"} ${row.storageKey}: ${row.mimeType} -> ${resolved}`);

    if (opts.apply) {
      await db
        .update(uploads)
        .set({ mimeType: resolved, updatedAt: new Date() })
        .where(eq(uploads.id, row.id));
    }
  }

  console.log("");
  if (transitions.size > 0) {
    console.log("transitions:");
    for (const [key, n] of [...transitions].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${key}: ${n}`);
    }
  }
  console.log(
    `\n${changed} row(s) ${opts.apply ? "updated" : "would be updated"}` +
      `, ${reportedOnly} reported only, ${missing} unreadable`,
  );

  if (opts.backfillDimensions) await backfillDimensions(opts);

  if (!opts.apply && (changed > 0 || opts.backfillDimensions)) {
    console.log("\nnothing was written. Re-run with --apply to commit.");
  }
  process.exit(0);
}

/**
 * Fill width/height/blurhash for images that never got them.
 *
 * The importer inserted rows without decoding anything, so several thousand
 * images carry no dimensions - which costs them their aspect-ratio placeholder
 * in the grid and the size line on their card. Separate phase, separate flag:
 * it decodes real pixels, so it is much more expensive than the type repair and
 * nobody should pay for it by accident.
 *
 * Resumable by construction (`where width is null`), and a decoder failure is a
 * line of output rather than an exception - the AVIF sequence that started all
 * of this is precisely a file sharp cannot open.
 */
async function backfillDimensions(opts: Options): Promise<void> {
  console.log("\nbackfilling image dimensions...");

  const rows = await db
    .select({
      id: uploads.id,
      storageKey: uploads.storageKey,
      mimeType: uploads.mimeType,
      ext: uploads.ext,
      size: uploads.size,
    })
    .from(uploads)
    .where(
      and(
        isNull(uploads.width),
        isNull(uploads.deletedAt),
        sql`lower(${uploads.mimeType}) like 'image/%'`,
        sql`${uploads.size} <= ${MAX_DECODE_BYTES}`,
      ),
    )
    .limit(opts.limit ?? 1_000_000);

  console.log(`  ${rows.length} image(s) without dimensions`);

  let filled = 0;
  let failed = 0;
  const storage = getStorage();

  // A small worker pool: sharp is single-threaded here, and reading thousands
  // of files one at a time would take hours on a spinning disk.
  const queue = [...rows];
  const workers = Array.from({ length: DECODE_CONCURRENCY }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      try {
        const buf = await storage.readBuffer(row.storageKey);
        const meta = await imageMetaFromBuffer(buf);
        if (!meta.width || !meta.height) {
          failed++;
          if (opts.verbose) console.log(`  ! ${row.storageKey}: not decodable`);
          continue;
        }
        filled++;
        if (opts.verbose) {
          console.log(`  + ${row.storageKey}: ${meta.width}x${meta.height}`);
        }
        if (opts.apply) {
          await db
            .update(uploads)
            .set({ width: meta.width, height: meta.height, blurhash: meta.blurhash ?? null })
            .where(eq(uploads.id, row.id));
        }
      } catch {
        failed++;
        if (opts.verbose) console.log(`  ! ${row.storageKey}: unreadable`);
      }
    }
  });
  await Promise.all(workers);

  console.log(`  ${filled} ${opts.apply ? "filled" : "would be filled"}, ${failed} skipped`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
