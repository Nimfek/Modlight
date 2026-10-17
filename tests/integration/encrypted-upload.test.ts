import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "@tus/file-store";
import { Server as TusServer } from "@tus/server";
import {
  encryptedSource,
  planEncryption,
  serverVisibleMeta,
  type EncryptionPlan,
} from "@/components/upload/encrypted-source";
import {
  decryptedFrames,
  fetchContainerHead,
  openContainer,
} from "@/components/viewer/decrypt-transfer";
import { encryptedLink, urlLeaksKey } from "@/lib/crypto/link";
import { CONTAINER_MAGIC, ENCRYPTED_MIME, HEADER_PROBE_BYTES } from "@/lib/crypto/envelope";

/**
 * The round trip, end to end, over real sockets.
 *
 * Nothing here is mocked that matters: the upload goes through the same
 * @tus/server and @tus/file-store the deployment runs, driven by the same
 * `encryptedSource` the browser drives, and the download goes through the same
 * `decrypt-transfer` module the viewer uses, against a server that honours
 * Range exactly as `streamMedia` does.
 *
 * Both servers record every request line and every header they receive, which
 * is what turns "the key never reaches the server" from a claim into evidence:
 * the log is searched for the key afterwards, and the transfer would have had
 * to put it somewhere for it to be found.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Small frames, so a few megabytes still exercises many of them. */
const CHUNK = 256 * 1024;
const PLAIN_SIZE = 3 * 1024 * 1024 + 1_337;
const REAL_NAME = "quarterly-figures.png";
const REAL_TYPE = "image/png";

interface LoggedRequest {
  line: string;
  headers: http.IncomingHttpHeaders;
}

function recorder() {
  const log: LoggedRequest[] = [];
  return {
    log,
    note(req: http.IncomingMessage) {
      log.push({ line: `${req.method} ${req.url} HTTP/${req.httpVersion}`, headers: req.headers });
    },
    /** Every scrap of text the server could possibly have written down. */
    text(): string {
      return log
        .map(
          (entry) =>
            `${entry.line}\n${Object.entries(entry.headers)
              .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : v}`)
              .join("\n")}`,
        )
        .join("\n");
    },
  };
}

const sha = (bytes: Uint8Array | Buffer) => createHash("sha256").update(bytes).digest("hex");

/* -------------------------------------------------------------------------- */
/* Upload: the tus protocol, driven exactly as tus-js-client drives it.        */
/* -------------------------------------------------------------------------- */

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function bootTus() {
  const directory = await mkdtemp(join(tmpdir(), "modlight-e2ee-tus-"));
  dirs.push(directory);
  const tus = new TusServer({ path: "/files", datastore: new FileStore({ directory }) });
  const rec = recorder();
  const server = http.createServer((req, res) => {
    rec.note(req);
    tus.handle(req, res).catch(() => res.end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { directory, server, rec, port: (server.address() as { port: number }).port };
}

/** Push a container to a tus server, one PATCH per frame, resuming as needed. */
async function push(
  port: number,
  path: string,
  source: ReturnType<typeof encryptedSource>,
  chunkBytes: number,
  opts: { cutAt?: number } = {},
): Promise<number> {
  let offset = 0;
  let patches = 0;
  let cut = opts.cutAt;

  while (offset < source.size) {
    const { value } = await source.slice(offset, Math.min(offset + chunkBytes, source.size));
    const body = Buffer.from(await (value as Blob).arrayBuffer());

    if (cut != null && offset >= cut) {
      // A connection that dies mid-body: the bytes stop arriving with no FIN.
      await new Promise<void>((resolve) => {
        const req = http.request({
          host: "127.0.0.1",
          port,
          method: "PATCH",
          path,
          headers: {
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": String(offset),
            "Content-Type": "application/offset+octet-stream",
            "Content-Length": String(body.length),
          },
        });
        req.on("error", () => resolve());
        req.write(body.subarray(0, Math.floor(body.length / 3)), () => {
          setTimeout(() => {
            req.destroy();
            resolve();
          }, 120);
        });
      });
      await new Promise((r) => setTimeout(r, 250));
      cut = undefined;

      // Ask the server where it really got to. This is the number the whole
      // design turns on: it will NOT be on a frame boundary.
      const head = await request(port, "HEAD", path, {
        "Tus-Resumable": "1.0.0",
        "Cache-Control": "no-store",
      });
      offset = Number(head.headers["upload-offset"]);
      expect(Number.isFinite(offset)).toBe(true);
      continue;
    }

    const res = await request(
      port,
      "PATCH",
      path,
      {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
        "Content-Length": String(body.length),
      },
      body,
    );
    expect(res.status).toBe(204);
    offset = Number(res.headers["upload-offset"]);
    patches++;
  }
  return patches;
}

/* -------------------------------------------------------------------------- */
/* Download: a Range-honouring server, so the viewer's real code can run.      */
/* -------------------------------------------------------------------------- */

async function bootRaw(bytes: Buffer) {
  const rec = recorder();
  const server = http.createServer((req, res) => {
    rec.note(req);
    const range = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range ?? "").trim());
    if (!range) {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Accept-Ranges": "bytes",
      });
      res.end(bytes);
      return;
    }
    const start = range[1] === "" ? 0 : Number(range[1]);
    const end = range[2] === "" ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
    const slice = bytes.subarray(start, end + 1);
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
      "Content-Length": String(slice.length),
      "Accept-Ranges": "bytes",
    });
    res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, rec, port: (server.address() as { port: number }).port };
}

/* -------------------------------------------------------------------------- */

describe("end-to-end encrypted upload", () => {
  it("stores ciphertext, survives a dropped connection, and comes back byte for byte", async () => {
    const plaintext = randomBytes(PLAIN_SIZE);
    const plainHash = sha(plaintext);

    const plan: EncryptionPlan = await planEncryption(
      { name: REAL_NAME, type: REAL_TYPE, size: plaintext.length },
      { chunkBytes: CHUNK },
    );
    const source = encryptedSource(new Blob([plaintext]), plan);

    /* ── upload ─────────────────────────────────────────────────────────── */
    const tus = await bootTus();
    const visible = serverVisibleMeta(plan);
    const created = await request(tus.port, "POST", "/files", {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(plan.cipherTotalBytes),
      "Upload-Metadata": [
        `filename ${Buffer.from(visible.name).toString("base64")}`,
        `filetype ${Buffer.from(visible.type).toString("base64")}`,
      ].join(","),
    });
    expect(created.status).toBe(201);
    const uploadPath = new URL(
      String(created.headers.location),
      `http://127.0.0.1:${tus.port}`,
    ).pathname;

    // Kill the connection roughly a third of the way in, then resume from
    // whatever the server actually kept.
    const patches = await push(tus.port, uploadPath, source, CHUNK + 16, {
      cutAt: Math.floor(plan.cipherTotalBytes / 3),
    });
    expect(patches).toBeGreaterThan(1);

    const stored = await readFile(join(tus.directory, uploadPath.split("/").pop() as string));
    tus.server.close();

    /* ── what the server is holding ─────────────────────────────────────── */
    console.log(`[e2ee] plaintext        ${plaintext.length} bytes  sha256 ${plainHash}`);
    console.log(`[e2ee] stored container ${stored.length} bytes  sha256 ${sha(stored)}`);
    console.log(`[e2ee] header (32 B)    ${stored.subarray(0, 32).toString("hex")}`);

    expect(stored.length).toBe(plan.cipherTotalBytes);
    expect(sha(stored)).not.toBe(plainHash);
    expect(stored.subarray(0, CONTAINER_MAGIC.length).toString("latin1")).toBe(CONTAINER_MAGIC);
    expect(stored[6]).toBe(0x00);
    // Not one recognisable run of the original anywhere in the stored file.
    expect(stored.includes(plaintext.subarray(0, 128))).toBe(false);
    expect(stored.includes(plaintext.subarray(PLAIN_SIZE - 128))).toBe(false);

    /* ── what the server was TOLD ───────────────────────────────────────── */
    const uploadLog = tus.rec.text();
    expect(uploadLog).not.toContain(REAL_NAME);
    expect(uploadLog).not.toContain(REAL_TYPE);
    expect(uploadLog).toContain(Buffer.from(visible.name).toString("base64"));
    expect(visible.type).toBe(ENCRYPTED_MIME);

    /* ── the key: absent from every request and every header ────────────── */
    expect(uploadLog).not.toContain(plan.encodedKey);
    for (const entry of tus.rec.log) {
      expect(urlLeaksKey(entry.line, plan.encodedKey), entry.line).toBe(false);
    }

    /* ── the link, and what a browser would actually request ────────────── */
    const page = "https://h.example.com/ToqOse/quiet-harbour-42.mlenc";
    const link = encryptedLink(page, plan.encodedKey);
    const asRequested = new URL(link);
    console.log(`[e2ee] shared link      ${link}`);
    console.log(
      `[e2ee] on the wire      GET ${asRequested.pathname}${asRequested.search} (no fragment)`,
    );
    expect(`${asRequested.origin}${asRequested.pathname}${asRequested.search}`).toBe(page);
    expect(asRequested.search).toBe("");

    /* ── download, through the viewer's own code ────────────────────────── */
    const raw = await bootRaw(stored);
    const url = `http://127.0.0.1:${raw.port}/ToqOse/quiet-harbour-42/raw.mlenc`;

    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(plan.encodedKey.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
      "AES-GCM",
      false,
      ["decrypt"],
    );

    const { head, complete } = await fetchContainerHead(url);
    const opened = await openContainer(head, key);
    expect(opened.metadata).toEqual({ name: REAL_NAME, type: REAL_TYPE });
    expect(opened.params.plainTotalBytes).toBe(PLAIN_SIZE);

    const parts: Uint8Array[] = [];
    for await (const frame of decryptedFrames({
      url,
      key,
      params: opened.params,
      head,
      complete,
    })) {
      parts.push(frame);
    }
    const recovered = Buffer.concat(parts);
    raw.server.close();

    expect(recovered.length).toBe(PLAIN_SIZE);
    expect(sha(recovered)).toBe(plainHash);
    console.log(`[e2ee] recovered        ${recovered.length} bytes  sha256 ${sha(recovered)}`);

    /* ── exactly two requests, and only the first one counts a view ─────── */
    const rangeHeaders = raw.rec.log.map((entry) => String(entry.headers.range));
    expect(raw.rec.log.length).toBe(2);
    expect(rangeHeaders[0]).toBe(`bytes=0-${HEADER_PROBE_BYTES - 1}`);
    expect(rangeHeaders[1]).toBe(`bytes=${HEADER_PROBE_BYTES}-`);
    // `/raw` counts a request whose range starts at zero. Exactly one does.
    expect(rangeHeaders.filter((r) => /^bytes=0-/.test(r)).length).toBe(1);

    const downloadLog = raw.rec.text();
    console.log(`[e2ee] requests seen by the origin:\n${raw.rec.log.map((e) => e.line).join("\n")}`);
    expect(downloadLog).not.toContain(plan.encodedKey);
    expect(downloadLog).not.toContain(REAL_NAME);
    for (const entry of raw.rec.log) {
      expect(urlLeaksKey(entry.line, plan.encodedKey), entry.line).toBe(false);
    }
  }, 60_000);

  it("answers any container offset, so a resume never has to be frame aligned", async () => {
    const plaintext = randomBytes(CHUNK * 3 + 101);
    const plan = await planEncryption(
      { name: "misaligned.bin", type: "application/octet-stream", size: plaintext.length },
      { chunkBytes: CHUNK },
    );
    const source = encryptedSource(new Blob([plaintext]), plan);

    // The whole container, in one go, is the reference.
    const whole = Buffer.from(
      await ((await source.slice(0, source.size)).value as Blob).arrayBuffer(),
    );
    expect(whole.length).toBe(plan.cipherTotalBytes);

    // Now the same bytes, requested at offsets that fall inside frames, inside
    // the header, and across boundaries - which is what a killed PATCH leaves.
    for (const [from, to] of [
      [0, 7],
      [17, plan.plan.headerBytes + 5],
      [plan.plan.headerBytes + 1, plan.plan.headerBytes + CHUNK + 40],
      [plan.cipherTotalBytes - 3, plan.cipherTotalBytes],
      [Math.floor(plan.cipherTotalBytes / 2) + 13, plan.cipherTotalBytes],
    ]) {
      const { value, done } = await source.slice(from, to);
      const bytes = Buffer.from(await (value as Blob).arrayBuffer());
      expect(bytes, `slice ${from}..${to}`).toEqual(whole.subarray(from, to));
      expect(done).toBe(to >= plan.cipherTotalBytes);
    }
  }, 30_000);
});
