import { LocalDriver } from "./local";
import { S3Driver } from "./s3";
import type { StorageDriver } from "./types";

export type { StorageDriver, ByteRange, StatResult } from "./types";
export { LocalDriver } from "./local";
export { S3Driver } from "./s3";

let singleton: StorageDriver | null = null;

/** Build the configured storage driver from env (memoized for the process). */
export function getStorage(): StorageDriver {
  if (singleton) return singleton;

  const driver = (process.env.STORAGE_DRIVER ?? "local").toLowerCase();

  if (driver === "s3") {
    singleton = new S3Driver({
      endpoint: process.env.S3_ENDPOINT || undefined,
      region: process.env.S3_REGION || "auto",
      bucket: required("S3_BUCKET"),
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      prefix: process.env.S3_PREFIX || undefined,
    });
  } else {
    singleton = new LocalDriver(process.env.STORAGE_LOCAL_PATH ?? "./data/storage");
  }

  return singleton;
}

/**
 * First `bytes` of a stored object, for content sniffing.
 *
 * A ranged read, so it costs the same on a 4 KB screenshot and on a 2 GB video -
 * `readBuffer()` would pull the whole file into memory to look at its header.
 * Both drivers already speak ranges (the local one via createReadStream, S3 via
 * a ranged GetObject), so no driver method had to be invented for this.
 *
 * Returns an empty buffer when the object cannot be read: a missing file is a
 * reason to fall back to other evidence, not to fail an upload whose bytes are
 * already safely on disk.
 */
export async function readHead(key: string, bytes = 4096): Promise<Buffer> {
  try {
    const stream = await getStorage().readStream(key, { start: 0, end: bytes - 1 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
      // A driver may ignore the range; stop reading once we have enough.
      if (chunks.reduce((n, c) => n + c.length, 0) >= bytes) break;
    }
    return Buffer.concat(chunks).subarray(0, bytes);
  } catch {
    return Buffer.alloc(0);
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} for S3 storage driver`);
  return v;
}
