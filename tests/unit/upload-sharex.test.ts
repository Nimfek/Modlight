import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/**
 * These exercise the raw HTTP layer on purpose: the bug they guard against
 * (a dropped connection leaving the handler, the socket and a temp file
 * pending forever) is invisible to any test that calls the handler with fake
 * request objects.
 *
 * The module reads config at import time, so env has to be in place first —
 * hence the dynamic import.
 */
const ANON_LIMIT = 4096;
const BOUNDARY = "----modlighttest";

let tmpRoot: string;
let handleShareXUpload: typeof import("@/lib/upload/sharex").handleShareXUpload;
let bearerFromHeaders: typeof import("@/lib/upload/sharex").bearerFromHeaders;
let server: Server;
let port: number;
/** Resolves/rejects exactly as the handler does, so tests can await settlement. */
let inFlight: Promise<void> = Promise.resolve();

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "modlight-sharex-"));
  process.env.UPLOAD_TMP_PATH = tmpRoot;
  process.env.LEGACY_UPLOAD_MAX_SIZE = String(ANON_LIMIT);

  ({ handleShareXUpload, bearerFromHeaders } = await import("@/lib/upload/sharex"));

  server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    inFlight = handleShareXUpload(req, res);
    inFlight.catch(() => {
      /* surfaced by the assertions instead */
    });
  });
  server.listen(0);
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server?.close();
  await rm(tmpRoot, { recursive: true, force: true });
});

function filePart(filename: string): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="upload"; filename="${filename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
}

const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);

function post(body: Buffer): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        method: "POST",
        path: "/upload",
        headers: {
          "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
          "content-length": body.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("bearerFromHeaders", () => {
  it("prefers the x-api-key header the generated .sxcu sends", () => {
    expect(bearerFromHeaders({ headers: { "x-api-key": "abc123" } })).toBe("abc123");
  });

  it("accepts an Authorization: Bearer token, case-insensitively", () => {
    expect(bearerFromHeaders({ headers: { authorization: "Bearer abc123" } })).toBe("abc123");
    expect(bearerFromHeaders({ headers: { authorization: "bearer abc123" } })).toBe("abc123");
  });

  it("ignores other schemes and empty values", () => {
    expect(bearerFromHeaders({ headers: { authorization: "Basic dXNlcjpwdw==" } })).toBeUndefined();
    expect(bearerFromHeaders({ headers: { authorization: "Bearer   " } })).toBeUndefined();
    expect(bearerFromHeaders({ headers: {} })).toBeUndefined();
  });
});

describe("handleShareXUpload", () => {
  it("rejects a token-less upload with 400 and leaves no temp file behind", async () => {
    const body = Buffer.concat([filePart("note.txt"), Buffer.from("hello"), tail]);
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(res.json.message).toBe("Token not specified.");
    await inFlight;
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("caps an unauthenticated body at ANON_MAX_BYTES so nobody can fill the disk", async () => {
    // The legacy .sxcu sends its token as a form field that can arrive AFTER the
    // file, so anonymous bytes must be bounded until one shows up.
    const body = Buffer.concat([
      filePart("flood.bin"),
      Buffer.alloc(ANON_LIMIT * 4, 0x41),
      tail,
    ]);
    const res = await post(body);

    expect(res.status).toBe(413);
    expect(String(res.json.message)).toContain("x-api-key");
    await inFlight;
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  // 20s: this one deliberately abandons a socket and waits for the server to
  // notice, so it is slow by design and lands near the default 5s budget. With
  // the rest of the suite running in parallel it tips over — and a test whose
  // whole subject is "does it settle" must not itself report a hang that isn't.
  it("settles instead of hanging when the client vanishes mid-upload", { timeout: 20_000 }, async () => {
    // The regression: busboy never emits 'close' for a body that stopped
    // arriving, so awaiting it alone pinned the handler (and its temp file)
    // forever. Content-Length promises far more than we intend to send.
    const head = filePart("dropped.bin");
    const req = http.request({
      port,
      method: "POST",
      path: "/upload",
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "content-length": head.length + 10_000_000,
      },
    });
    req.on("error", () => {
      /* expected: we destroy this socket on purpose */
    });
    req.write(head);
    req.write(Buffer.alloc(2048, 0x42));
    await new Promise((r) => setTimeout(r, 50)); // let the server start consuming
    req.destroy();

    // The assertion is simply that this resolves at all.
    await expect(
      Promise.race([
        inFlight.catch(() => "settled"),
        // 15s, not 5: Round 10b raised this test's own budget to 20s because a
        // parallel run pushes it past 5, and then left the INNER race at 5000 -
        // so the suite still reported "handler hung" for a handler that settles.
        // Observed again today on a full run, and passing on its own seconds later.
        // The race must sit inside the budget it is measured against, or it is
        // the very thing this test exists to disprove: a false report of a hang.
        new Promise((_, reject) => setTimeout(() => reject(new Error("handler hung")), 15_000)),
      ]),
    ).resolves.not.toThrow();

    expect(await readdir(tmpRoot)).toEqual([]);
  });
});
