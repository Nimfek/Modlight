/**
 * Deciding whether a ZIP is safe to hand to a library that will expand all of it.
 *
 * A .docx is a ZIP, and mammoth takes the whole archive as a buffer and unpacks
 * what it needs through JSZip - pure JavaScript, on the main thread, with no
 * output bound anywhere in the chain. A 10 MB upload of highly compressible
 * nothing expands to gigabytes, and the process is dead before any timeout can
 * fire, because synchronous JavaScript cannot be interrupted.
 *
 * So the check has to happen BEFORE mammoth sees the buffer, and it cannot be a
 * question the file answers about itself.
 *
 * The lazy version of this guard reads the sizes recorded in the central
 * directory and adds them up. That is worth doing - it is nearly free and it
 * catches every naive bomb - but it is a guard against accidents, not against an
 * attacker, because those fields are just numbers in the file. The archive can
 * say each entry expands to 4 kB and expand to 4 GB.
 *
 * So the declared sizes are treated as a claim to be checked, and the archive is
 * really inflated here, entry by entry, through Node's zlib with
 * `maxOutputLength` set. That option makes the bound real: zlib stops and throws
 * at the limit rather than returning what it has produced. The cost is
 * decompressing twice, which for the 2.3 MB that is the 90th percentile of the
 * documents on this deployment is a few milliseconds, and it turns "the file
 * claims to be safe" into "the file is safe".
 */

import { inflateRawSync } from "node:zlib";

/** Signatures, little-endian. */
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** A ZIP comment may be 64 kB, so the trailer can be that far from the end. */
const MAX_COMMENT = 0xffff;

/** The sentinel a ZIP64 archive writes where a 32-bit size would go. */
const ZIP64_SENTINEL = 0xffffffff;

export interface ZipLimits {
  /** Everything in the archive, expanded, may not exceed this. */
  totalBytes: number;
  /** ...and no single entry may. */
  entryBytes: number;
  /** Number of entries. A million empty files is also a denial of service. */
  entryCount: number;
}

export type ZipVerdict =
  | { ok: true; totalBytes: number; entries: number }
  | { ok: false; reason: ZipRefusal };

export type ZipRefusal =
  | "not-a-zip"
  /** Structurally broken: truncated, overlapping, or lying about its offsets. */
  | "malformed"
  /** Declared or real expansion beyond what we allow. */
  | "too-big"
  | "too-many-entries"
  /** Needs 64-bit offsets, so it is at least 4 GB and not a document. */
  | "zip64"
  /** A compression method we do not implement (and neither should a .docx). */
  | "unsupported-method";

interface Entry {
  name: string;
  method: number;
  compressed: number;
  declared: number;
  localOffset: number;
}

/**
 * Find the End of Central Directory record, scanning back from the end.
 *
 * Returns the offset of the central directory and how many entries it holds.
 */
function readEocd(buf: Buffer): { offset: number; count: number } | null {
  const earliest = Math.max(0, buf.length - MAX_COMMENT - 22);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) !== EOCD) continue;
    const count = buf.readUInt16LE(i + 10);
    const offset = buf.readUInt32LE(i + 16);
    const size = buf.readUInt32LE(i + 12);
    if (offset === ZIP64_SENTINEL || size === ZIP64_SENTINEL || count === 0xffff) return null;
    if (offset + size > buf.length) return null;
    return { offset, count };
  }
  return null;
}

/** Walk the central directory into a list of entries, or null if it is broken. */
function readCentralDirectory(buf: Buffer, start: number, count: number): Entry[] | null {
  const entries: Entry[] = [];
  let p = start;

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) return null;

    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const declared = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);

    // Any ZIP64 sentinel means the real value lives in an extra field. A
    // document that needs one is at least 4 GB, so rather than implement the
    // parsing we refuse the whole class - and refusing is the safe direction.
    if (compressed === ZIP64_SENTINEL || declared === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
      return null;
    }

    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressed, declared, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Where an entry's compressed bytes actually start.
 *
 * The local header repeats the name and extra fields with different lengths from
 * the central one, so the data offset cannot be computed from the central
 * directory alone - a detail that has produced parser mismatches in real
 * software, which is the sort of disagreement archive attacks are built on.
 */
function dataRange(buf: Buffer, entry: Entry): { start: number; end: number } | null {
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL) return null;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + entry.compressed;
  if (end > buf.length || start > end) return null;
  return { start, end };
}

/**
 * Is this archive safe to expand?
 *
 * Every entry is really decompressed against a hard output bound. Nothing is
 * returned but the verdict: the point is to answer the question before the
 * library that will do the real work gets the buffer.
 */
export function inspectZip(buf: Buffer, limits: ZipLimits): ZipVerdict {
  if (buf.length < 22 || buf.readUInt32LE(0) !== LOCAL) {
    return { ok: false, reason: "not-a-zip" };
  }

  const eocd = readEocd(buf);
  if (!eocd) return { ok: false, reason: "zip64" };
  if (eocd.count > limits.entryCount) return { ok: false, reason: "too-many-entries" };

  const entries = readCentralDirectory(buf, eocd.offset, eocd.count);
  if (!entries) return { ok: false, reason: "malformed" };

  // The cheap pass first: a bomb that is honest about itself never reaches the
  // expensive one, and a file whose own numbers already exceed the budget is
  // refused for the price of reading them.
  let declaredTotal = 0;
  for (const entry of entries) {
    if (entry.declared > limits.entryBytes) return { ok: false, reason: "too-big" };
    declaredTotal += entry.declared;
    if (declaredTotal > limits.totalBytes) return { ok: false, reason: "too-big" };
    if (entry.method !== 0 && entry.method !== 8) {
      return { ok: false, reason: "unsupported-method" };
    }
  }

  // ...and now the pass that does not take the file's word for any of it.
  let realTotal = 0;
  for (const entry of entries) {
    const range = dataRange(buf, entry);
    if (!range) return { ok: false, reason: "malformed" };

    // Whatever budget is left, so a set of entries that are individually fine
    // cannot add up to a bomb.
    const remaining = limits.totalBytes - realTotal;
    if (remaining <= 0 && entry.compressed > 0) return { ok: false, reason: "too-big" };

    if (entry.method === 0) {
      // Stored: the compressed length IS the real length, nothing to verify.
      realTotal += entry.compressed;
    } else {
      try {
        const out = inflateRawSync(buf.subarray(range.start, range.end), {
          // The bound that makes this a guard rather than a formality: zlib
          // throws at the limit instead of handing back what it has managed.
          maxOutputLength: Math.min(limits.entryBytes, remaining) + 1,
        });
        realTotal += out.length;
      } catch {
        // Either it blew the budget or it is not valid deflate. Both are
        // reasons not to hand this file to a library that will try again.
        return { ok: false, reason: "too-big" };
      }
    }

    if (realTotal > limits.totalBytes) return { ok: false, reason: "too-big" };
  }

  return { ok: true, totalBytes: realTotal, entries: entries.length };
}
