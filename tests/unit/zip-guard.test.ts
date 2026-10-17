import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { inspectZip, type ZipLimits } from "@/lib/media/zip-guard";

/**
 * A minimal ZIP writer, so the tests can build archives that a real one would
 * refuse to produce - above all, one whose central directory LIES about how big
 * its entries are. That case is the whole reason the guard inflates rather than
 * adding up declared sizes, and it cannot be exercised with a normal zip tool.
 */
interface Member {
  name: string;
  body: Buffer;
  /** Overrides the true uncompressed size written into both headers. */
  declaredSize?: number;
  /** 0 = stored, 8 = deflate. */
  method?: number;
}

function buildZip(members: Member[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const m of members) {
    const method = m.method ?? 8;
    const data = method === 8 ? deflateRawSync(m.body) : m.body;
    const name = Buffer.from(m.name, "utf8");
    const declared = m.declaredSize ?? m.body.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // crc, unchecked by the guard
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, eocd]);
}

const LIMITS: ZipLimits = { totalBytes: 1_000_000, entryBytes: 500_000, entryCount: 32 };

describe("the zip bomb guard", () => {
  it("accepts an ordinary archive", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", body: Buffer.from("<Types/>") },
      { name: "word/document.xml", body: Buffer.from("<w:document>hello</w:document>") },
    ]);
    const verdict = inspectZip(zip, LIMITS);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.entries).toBe(2);
      expect(verdict.totalBytes).toBe(38);
    }
  });

  it("refuses anything that is not a zip at all", () => {
    expect(inspectZip(Buffer.from("not a zip"), LIMITS)).toEqual({ ok: false, reason: "not-a-zip" });
    // An OLE2 compound file - a real .doc - starts with this and is not a zip.
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(inspectZip(ole, LIMITS)).toEqual({ ok: false, reason: "not-a-zip" });
  });

  it("refuses a bomb that is honest about its size, without decompressing it", () => {
    // The cheap pass: the archive's own numbers already exceed the budget.
    const zip = buildZip([{ name: "big.xml", body: Buffer.alloc(600_000, 0x41) }]);
    expect(inspectZip(zip, LIMITS)).toEqual({ ok: false, reason: "too-big" });
  });

  it("refuses a bomb that LIES about its size", () => {
    // The case the whole design turns on. A megabyte of zeroes deflates to
    // about a kilobyte; the headers claim it expands to 100 bytes. Anything
    // that trusted the declared sizes would wave this straight through to
    // JSZip, which expands it for real on the main thread.
    const zip = buildZip([
      { name: "lie.xml", body: Buffer.alloc(2_000_000, 0), declaredSize: 100 },
    ]);
    expect(inspectZip(zip, LIMITS)).toEqual({ ok: false, reason: "too-big" });
  });

  it("refuses entries that are each fine but add up to a bomb", () => {
    // Every entry is a fifth of the per-entry ceiling; ten of them are not.
    const members = Array.from({ length: 10 }, (_, i) => ({
      name: `part${i}.bin`,
      body: Buffer.alloc(150_000, 0),
    }));
    expect(inspectZip(buildZip(members), LIMITS)).toEqual({ ok: false, reason: "too-big" });
  });

  it("refuses an archive with too many entries", () => {
    const members = Array.from({ length: 40 }, (_, i) => ({
      name: `f${i}`,
      body: Buffer.from("x"),
    }));
    expect(inspectZip(buildZip(members), LIMITS)).toEqual({
      ok: false,
      reason: "too-many-entries",
    });
  });

  it("refuses a compression method it cannot verify", () => {
    // Only stored and deflate. Anything else (bzip2, lzma, ppmd) would have to
    // be waved through unverified, which is exactly what this guard exists to
    // avoid - and a .docx never uses one.
    const zip = buildZip([{ name: "x.xml", body: Buffer.from("hello"), method: 12 }]);
    expect(inspectZip(zip, LIMITS)).toEqual({ ok: false, reason: "unsupported-method" });
  });

  it("counts stored entries at their real length", () => {
    const zip = buildZip([{ name: "raw.bin", body: Buffer.alloc(600_000, 0x42), method: 0 }]);
    expect(inspectZip(zip, LIMITS)).toEqual({ ok: false, reason: "too-big" });
  });

  it("refuses a truncated or overlapping archive rather than guessing", () => {
    const zip = buildZip([{ name: "a.xml", body: Buffer.from("hello") }]);
    // Corrupt the local header signature the central directory points at.
    const broken = Buffer.from(zip);
    broken.writeUInt32LE(0xdeadbeef, 0);
    const verdict = inspectZip(broken, LIMITS);
    expect(verdict.ok).toBe(false);
  });

  it("refuses an archive whose trailer is missing", () => {
    const zip = buildZip([{ name: "a.xml", body: Buffer.from("hello") }]);
    expect(inspectZip(zip.subarray(0, zip.length - 22), LIMITS).ok).toBe(false);
  });

  it("accepts a zip with a trailing comment, which is legal", () => {
    const zip = buildZip([{ name: "a.xml", body: Buffer.from("hello") }]);
    const eocdStart = zip.length - 22;
    const comment = Buffer.from("packed by something");
    const withComment = Buffer.concat([zip, comment]);
    withComment.writeUInt16LE(comment.length, eocdStart + 20);
    expect(inspectZip(withComment, LIMITS).ok).toBe(true);
  });
});
