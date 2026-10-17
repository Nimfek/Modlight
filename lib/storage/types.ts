import type { Readable } from "node:stream";

export interface ByteRange {
  /** inclusive start offset */
  start: number;
  /** inclusive end offset */
  end: number;
}

export interface StatResult {
  size: number;
}

/**
 * Storage abstraction. A single interface backs local disk and S3-compatible
 * object stores. The whole app talks to storage only through this — never the
 * filesystem or an SDK directly — so swapping backends is a config change.
 *
 * Design goals (driven by the large-file reliability requirement):
 *  - everything streams; nothing buffers a whole file in memory
 *  - readStream supports byte ranges for HTTP Range / 206 media serving
 *  - ingest() finalizes a completed upload (e.g. a tus temp file) into place
 *    without an extra full re-read where the backend can avoid it
 */
export interface StorageDriver {
  readonly name: "local" | "s3";

  /** Stream-write `body` to `path` (creates parent dirs as needed). */
  write(path: string, body: Readable | Buffer): Promise<void>;

  /**
   * Finalize an already-completed upload that currently lives at an absolute
   * local temp path (e.g. the tus FileStore output) into our storage `path`.
   * Local driver can move/rename (fast, no copy); S3 driver streams it up.
   * If the temp file should be removed afterwards, drivers handle that.
   */
  ingestLocalFile(localTmpPath: string, path: string): Promise<void>;

  /** Open a read stream, optionally for a byte range (for Range requests). */
  readStream(path: string, range?: ByteRange): Promise<Readable>;

  /** Read the whole object into a Buffer (small files only: text preview, thumbs source). */
  readBuffer(path: string): Promise<Buffer>;

  stat(path: string): Promise<StatResult | null>;
  exists(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;

  /**
   * Delete every object whose key starts with `prefix` (which must end in "/").
   *
   * Exists for derived files — cached conversions live under
   * `derived/{uploadId}/…` and have to disappear with their source, in one call,
   * without the caller having to remember which variants were ever produced.
   * Missing prefixes are success: there is nothing to clean up.
   */
  deletePrefix(prefix: string): Promise<void>;

  /**
   * Optional: a presigned URL to read the object directly from the backend
   * (S3 only). Returns null for backends that can't (local). Lets us offload
   * large downloads to the object store instead of proxying through Node.
   */
  presignGet?(path: string, expiresInSeconds?: number): Promise<string | null>;

  /**
   * Optional: a filesystem path an external PROCESS can open, or null when the
   * bytes do not live on a filesystem we share with it.
   *
   * Exists for ffmpeg, which reads files rather than buffers. On the local
   * driver the object already is a file, so handing over its path avoids
   * copying up to half a gigabyte per conversion; on S3 there is no such path
   * and the caller stages a temp copy instead.
   *
   * Declared here rather than discovered with `instanceof` at the call site,
   * which is the whole reason this interface exists - and which also made the
   * build tracer follow a concrete driver's path handling into every route.
   */
  localPath?(path: string): string | null;
}
