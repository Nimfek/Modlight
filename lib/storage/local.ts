import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, copyFile, rm, stat as fsStat, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ByteRange, StatResult, StorageDriver } from "./types";

/**
 * Local filesystem storage driver. All paths are relative keys like
 * "{userCode}/{code}.{ext}", resolved under a single root directory.
 */
export class LocalDriver implements StorageDriver {
  readonly name = "local" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Resolve a storage key to an absolute path, guarding against traversal. */
  private full(key: string): string {
    const p = resolve(this.root, key);
    if (p !== this.root && !p.startsWith(this.root + sep)) {
      throw new Error(`Path traversal blocked: ${key}`);
    }
    return p;
  }

  async write(key: string, body: Readable | Buffer): Promise<void> {
    const target = this.full(key);
    await mkdir(dirname(target), { recursive: true });
    const out = createWriteStream(target);
    const src = Buffer.isBuffer(body) ? Readable.from(body) : body;
    await pipeline(src, out);
  }

  async ingestLocalFile(localTmpPath: string, key: string): Promise<void> {
    const target = this.full(key);
    await mkdir(dirname(target), { recursive: true });
    try {
      // Fast path: atomic rename when on the same filesystem.
      await rename(localTmpPath, target);
    } catch (err: unknown) {
      // Cross-device (EXDEV) or other: fall back to copy + unlink.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EXDEV" || code === "EPERM") {
        await copyFile(localTmpPath, target);
        await rm(localTmpPath, { force: true });
      } else {
        throw err;
      }
    }
  }

  async readStream(key: string, range?: ByteRange): Promise<Readable> {
    const target = this.full(key);
    if (range) {
      return createReadStream(target, { start: range.start, end: range.end });
    }
    return createReadStream(target);
  }

  async readBuffer(key: string): Promise<Buffer> {
    return readFile(this.full(key));
  }

  async stat(key: string): Promise<StatResult | null> {
    try {
      const s = await fsStat(this.full(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    await rm(this.full(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    // A prefix is a directory on this driver, so one recursive remove does it.
    // `full()` still runs, so a crafted prefix cannot escape the storage root.
    const dir = prefix.replace(/\/+$/, "");
    if (!dir) throw new Error("deletePrefix: refusing to delete the storage root");
    await rm(this.full(dir), { recursive: true, force: true });
  }

  // Local files are served by Node (no presigned URLs).
  async presignGet(): Promise<string | null> {
    return null;
  }

  /** Convenience for callers that need an absolute path (e.g. sharp from disk). */
  absolutePath(key: string): string {
    return this.full(key);
  }

  /**
   * The path an external process may open. Same guard as everything else here,
   * so a crafted key cannot hand ffmpeg something outside the storage root.
   */
  localPath(key: string): string | null {
    return this.full(key);
  }

  static joinKey(...parts: string[]): string {
    return join(...parts).split(sep).join("/");
  }
}
