import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "@tus/file-store";
import { Server as TusServer } from "@tus/server";

/**
 * Audit harness: does a tus upload survive a connection that dies mid-chunk?
 *
 * Runs the exact @tus/server + @tus/file-store versions production runs, over a
 * real socket, so the answer is about the shipped behaviour and not about a
 * mock. Auth/quota hooks are left out on purpose: those gate CREATION, and what
 * is under test here is what happens to bytes after creation succeeded.
 */

const dirs: string[] = [];
const TOTAL = 8 * 1024 * 1024;
const CUT_AFTER = 3 * 1024 * 1024;

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function boot() {
  const directory = await mkdtemp(join(tmpdir(), "modlight-audit-tus-"));
  dirs.push(directory);
  const tus = new TusServer({
    path: "/files",
    datastore: new FileStore({ directory, expirationPeriodInMilliseconds: 24 * 60 * 60 * 1000 }),
  });
  const server = http.createServer((req, res) => {
    tus.handle(req, res).catch(() => res.end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { directory, server, port };
}

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("tus: interrupted transfer", () => {
  it("keeps the bytes it already received and finishes byte-identical after a resume", async () => {
    const { directory, server, port } = await boot();
    const payload = randomBytes(TOTAL);
    const want = createHash("sha256").update(payload).digest("hex");

    // ── create ──
    const created = await request(port, "POST", "/files", {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(TOTAL),
      "Upload-Metadata": `filename ${Buffer.from("audit.bin").toString("base64")}`,
    });
    expect(created.status).toBe(201);
    const location = String(created.headers.location);
    const path = new URL(location, `http://127.0.0.1:${port}`).pathname;

    // ── first PATCH, killed mid-body (the dropped connection) ──
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: "PATCH",
        path,
        headers: {
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": "0",
          "Content-Type": "application/offset+octet-stream",
          "Content-Length": String(TOTAL),
        },
      });
      req.on("error", () => resolve());
      req.write(payload.subarray(0, CUT_AFTER), () => {
        // Destroying the socket is what a lost connection looks like to the
        // server: the body stops arriving with no FIN of its own.
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 150);
      });
    });

    // Give the server a moment to settle the aborted write.
    await new Promise((r) => setTimeout(r, 300));

    // ── how much survived? ──
    const head = await request(port, "HEAD", path, {
      "Tus-Resumable": "1.0.0",
      "Cache-Control": "no-store",
    });
    expect(head.status).toBe(200);
    const offset = Number(head.headers["upload-offset"]);
    console.log(`[audit] offset after the interruption: ${offset} of ${TOTAL}`);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(TOTAL);

    // ── resume from exactly there ──
    const resumed = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "PATCH",
          path,
          headers: {
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": String(offset),
            "Content-Type": "application/offset+octet-stream",
            "Content-Length": String(TOTAL - offset),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(payload.subarray(offset));
    });
    expect(resumed).toBe(204);

    const stored = await readFile(join(directory, path.split("/").pop() as string));
    expect(stored.length).toBe(TOTAL);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(want);

    server.close();
  }, 30_000);

  it("refuses to resume an upload whose expiration window has closed", async () => {
    // Expiration is measured from CREATION, not from last activity: a transfer
    // that is still running when the window closes is rejected mid-flight.
    const directory = await mkdtemp(join(tmpdir(), "modlight-audit-exp-"));
    dirs.push(directory);
    const store = new FileStore({ directory, expirationPeriodInMilliseconds: 1 });
    const tus = new TusServer({ path: "/files", datastore: store });
    const server = http.createServer((req, res) => {
      tus.handle(req, res).catch(() => res.end());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const created = await request(port, "POST", "/files", {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": "1024",
    });
    const path = new URL(String(created.headers.location), `http://127.0.0.1:${port}`).pathname;
    await new Promise((r) => setTimeout(r, 50));

    const patched = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "PATCH",
          path,
          headers: {
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": "0",
            "Content-Type": "application/offset+octet-stream",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(Buffer.alloc(1024));
    });

    console.log(`[audit] PATCH after expiry -> ${patched}`);
    expect(patched).toBe(410);
    server.close();
  }, 20_000);
});
