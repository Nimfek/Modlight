import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ByteRange, StatResult, StorageDriver } from "./types";

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  /** Optional key prefix inside the bucket. */
  prefix?: string;
}

/**
 * S3-compatible storage driver (AWS S3, MinIO, Cloudflare R2, Backblaze B2,
 * DigitalOcean Spaces). Uploads stream via multipart (lib-storage Upload), so a
 * multi-GB file is never held in memory; large downloads can be offloaded to the
 * bucket via presigned URLs.
 */
export class S3Driver implements StorageDriver {
  readonly name = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(cfg: S3Config) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: cfg.forcePathStyle ?? false,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
    this.bucket = cfg.bucket;
    this.prefix = (cfg.prefix ?? "").replace(/^\/+|\/+$/g, "");
  }

  private key(k: string): string {
    return this.prefix ? `${this.prefix}/${k}` : k;
  }

  async write(key: string, body: Readable | Buffer): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: this.key(key), Body: body },
      // 64 MB parts, up to 4 concurrent — good for large files without huge memory.
      queueSize: 4,
      partSize: 64 * 1024 * 1024,
    });
    await upload.done();
  }

  async ingestLocalFile(localTmpPath: string, key: string): Promise<void> {
    await this.write(key, createReadStream(localTmpPath));
    await rm(localTmpPath, { force: true });
  }

  async readStream(key: string, range?: ByteRange): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );
    return res.Body as Readable;
  }

  async readBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
    );
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async stat(key: string): Promise<StatResult | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      return { size: res.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
    );
  }

  async deletePrefix(prefix: string): Promise<void> {
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    if (normalized === "/") throw new Error("deletePrefix: refusing to empty the bucket");

    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.key(normalized),
          ContinuationToken: token,
        }),
      );
      const keys = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === "string");
      if (keys.length > 0) {
        // DeleteObjects takes 1000 keys per call, which is also the page size
        // ListObjectsV2 returns, so one round trip per page.
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }

  async presignGet(key: string, expiresInSeconds = 3600): Promise<string | null> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      { expiresIn: expiresInSeconds },
    );
  }
}
