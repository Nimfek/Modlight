import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskPressure, fitsOnDisk, sameFilesystem } from "@/lib/upload/disk";

const GIB = 1024 ** 3;

/**
 * Production numbers at the time of writing: a 96 GB system disk with 35 GB
 * free and a 10 GiB operator reserve, which leaves about 25 GB of real budget
 * for a single file.
 */
const FREE = 35 * GIB;
const RESERVE = 10 * GIB;

describe("fitsOnDisk", () => {
  it("accepts a file that leaves the reserve untouched", () => {
    expect(fitsOnDisk(25 * GIB, FREE, RESERVE)).toBe(true);
  });

  it("accepts a file that lands exactly on the reserve", () => {
    expect(fitsOnDisk(FREE - RESERVE, FREE, RESERVE)).toBe(true);
  });

  it("rejects a file one byte into the reserve", () => {
    expect(fitsOnDisk(FREE - RESERVE + 1, FREE, RESERVE)).toBe(false);
  });

  it("rejects the 50 GB file the user asked about, on today's disk", () => {
    // This is the answer to "will a 50 GB upload go through or be refused at the
    // end?": refused, and now refused at the first request rather than after an
    // hour of transferring.
    expect(fitsOnDisk(50 * GIB, FREE, RESERVE)).toBe(false);
  });

  it("accepts that same file once the dedicated 100 GB disk exists", () => {
    expect(fitsOnDisk(50 * GIB, 99 * GIB, RESERVE)).toBe(true);
  });

  it("never blocks an upload just because the filesystem could not be measured", () => {
    expect(fitsOnDisk(50 * GIB, null, RESERVE)).toBe(true);
  });

  it("still refuses to overfill the disk when the reserve is switched off", () => {
    expect(fitsOnDisk(FREE, FREE, 0)).toBe(true);
    expect(fitsOnDisk(FREE + 1, FREE, 0)).toBe(false);
  });

  it("waves through a free rename while there is headroom", () => {
    // What finalize asks after the payload is already staged on the same
    // filesystem: no new bytes, so the only question is whether the disk is
    // healthy at all.
    expect(fitsOnDisk(0, FREE, RESERVE)).toBe(true);
  });

  it("refuses everything once free space is already inside the reserve", () => {
    // The emergency the guard exists for: below the floor, even a free rename
    // must not be committed.
    expect(fitsOnDisk(0, 5 * GIB, RESERVE)).toBe(false);
  });
});

/**
 * The colour on the admin panel's disk meter.
 *
 * This is the only place in the product that reports on the MACHINE rather than
 * on an account, and the machine runs ten other production sites off the same
 * filesystem. The rules therefore have to fire before the disk is actually full,
 * and they have to stay quiet the rest of the time — an operator who learns that
 * the amber bar means nothing will not read the red one either.
 */
describe("diskPressure", () => {
  const TOTAL = 96 * GIB;

  it("is calm on today's production disk", () => {
    // 35 GB free of 96 GB, 10 GiB reserve: over a third free and three reserves
    // of headroom. Nothing to say.
    expect(diskPressure(FREE, TOTAL, RESERVE)).toBe("ok");
  });

  it("goes critical the moment uploads start being refused", () => {
    // Below the reserve `fitsOnDisk` returns false for every single upload,
    // including a free rename. The panel is the only place that can explain why
    // the 507s started, so the two thresholds are deliberately the same number.
    expect(fitsOnDisk(0, RESERVE - 1, RESERVE)).toBe(false);
    expect(diskPressure(RESERVE - 1, TOTAL, RESERVE)).toBe("critical");
    expect(diskPressure(RESERVE, TOTAL, RESERVE)).toBe("critical");
  });

  it("warns while there is still one reserve of headroom left", () => {
    // 15 GiB free against a 10 GiB floor: the next big file is the one that
    // fails, which is exactly when somebody can still do something about it.
    expect(diskPressure(15 * GIB, TOTAL, RESERVE)).toBe("low");
  });

  it("warns on a big disk long before the fixed reserve would notice", () => {
    // 4 TB disk, 300 GB free: thirty reserves of headroom, so the floor stays
    // silent, but the disk is 92% full and filling. The ratio is what catches it.
    const big = 4096 * GIB;
    expect(diskPressure(300 * GIB, big, RESERVE)).toBe("low");
    expect(diskPressure(150 * GIB, big, RESERVE)).toBe("critical");
    expect(diskPressure(900 * GIB, big, RESERVE)).toBe("ok");
  });

  it("still speaks up when the operator switched the reserve off", () => {
    // MIN_FREE_DISK_BYTES=0 disables the upload guard, not the disk.
    expect(diskPressure(2 * GIB, TOTAL, 0)).toBe("critical");
    expect(diskPressure(8 * GIB, TOTAL, 0)).toBe("low");
    expect(diskPressure(FREE, TOTAL, 0)).toBe("ok");
  });

  it("reports critical when the reserve is larger than the whole disk", () => {
    // A misconfigured floor means every upload is being refused on a disk that
    // is mostly empty. That is worth shouting about, not rounding down to "ok".
    expect(diskPressure(FREE, TOTAL, 200 * GIB)).toBe("critical");
  });

  it("says nothing at all about a filesystem it could not measure", () => {
    // statfs failed, or storage is an object store. Painting that green would be
    // a lie and painting it red would be a false alarm.
    expect(diskPressure(null, TOTAL, RESERVE)).toBe("unknown");
    expect(diskPressure(FREE, null, RESERVE)).toBe("unknown");
    expect(diskPressure(FREE, 0, RESERVE)).toBe("unknown");
    expect(diskPressure(Number.NaN, TOTAL, RESERVE)).toBe("unknown");
    expect(diskPressure(-1, TOTAL, RESERVE)).toBe("unknown");
  });

  it("handles a genuinely full disk", () => {
    expect(diskPressure(0, TOTAL, RESERVE)).toBe("critical");
  });
});

describe("sameFilesystem", () => {
  it("recognises two paths under one temp root", async () => {
    const root = await mkdtemp(join(tmpdir(), "modlight-fs-"));
    try {
      expect(await sameFilesystem(join(root, "storage"), join(root, "tmp"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("answers for directories that do not exist yet", async () => {
    // Storage and staging directories are created lazily; a missing directory
    // must not be mistaken for a different disk, or finalize would charge the
    // file's size a second time and reject an upload that already fits.
    const root = await mkdtemp(join(tmpdir(), "modlight-fs-"));
    try {
      const deep = join(root, "not", "created", "yet");
      expect(await sameFilesystem(deep, root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
