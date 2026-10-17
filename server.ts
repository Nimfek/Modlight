import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import v8 from "node:v8";
import next from "next";
import { config } from "@/lib/config";
import { cgroupCpuLimit, cgroupMemoryLimit } from "@/lib/runtime/limits";
// Importing this is what pins libvips to the cgroup's core count, before the
// first request can reach an image.
import { SHARP_CONCURRENCY } from "@/lib/media/sharp-runtime";
import { CONTAINER_MEMORY_BYTES as TRANSFORM_CONTAINER_MEMORY } from "@/lib/media/transform-cost";
import { createTusServer, sweepTusUploads, TUS_CLEANUP_INTERVAL_MS } from "@/lib/upload/tus";
import { handleShareXUpload } from "@/lib/upload/sharex";
import { purgeExpiredTrash, TRASH_SWEEP_INTERVAL_MS } from "@/lib/maintenance/trash";
import { warmMailSettings } from "@/lib/mail-settings";

/**
 * Custom Node HTTP server.
 *
 * The two upload paths stream multi-GB bodies with constant memory and no
 * framework body-size cap, intercepted at the RAW Node layer BEFORE Next.js:
 *   - POST /upload, /api/upload  -> ShareX single-POST (busboy streaming)
 *   - /api/files/*               -> tus resumable web uploads
 * Everything else -> Next.js (App Router, assets, media serving, API).
 *
 * A custom server is incompatible with output:'standalone' (see next.config.ts).
 */
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

// Ensure runtime directories exist.
const runtimeDirs = [config.uploads.tusTmpPath, config.uploads.tmpPath];
if (config.storage.driver === "local") runtimeDirs.push(config.storage.localPath);
for (const dir of runtimeDirs) mkdirSync(dir, { recursive: true });

const tus = createTusServer();

function fail(res: ServerResponse) {
  if (res.writableEnded || res.destroyed) return;
  if (!res.headersSent) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: "Internal server error" }));
    return;
  }
  res.end();
}

/**
 * A socket that dies mid-upload makes the request/response streams emit
 * 'error'. Node turns an unhandled 'error' event into an uncaught exception, so
 * a single dropped 5 GB upload would otherwise take the whole server down —
 * exactly the failure mode we are here to fix.
 */
function silenceStreamErrors(req: IncomingMessage, res: ServerResponse) {
  req.on("error", (err) => {
    if (dev) console.warn("[server] request stream error:", err.message);
  });
  res.on("error", (err) => {
    if (dev) console.warn("[server] response stream error:", err.message);
  });
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    silenceStreamErrors(req, res);

    const host = req.headers.host ?? `localhost:${config.port}`;
    const { pathname } = new URL(req.url ?? "/", `http://${host}`);

    // Resumable web uploads (tus).
    if (pathname.startsWith("/api/files")) {
      tus.handle(req, res).catch((err) => {
        console.error("[tus] handler error:", err);
        fail(res);
      });
      return;
    }

    // ShareX / legacy single-POST streaming upload.
    if (req.method === "POST" && (pathname === "/upload" || pathname === "/api/upload")) {
      handleShareXUpload(req, res).catch((err) => {
        console.error("[upload] handler error:", err);
        fail(res);
      });
      return;
    }

    // Everything else -> Next.js
    handle(req, res);
  });

  // Large uploads legitimately take hours; nothing at the Node layer may cut
  // them off. (Node's defaults are 300s / 60s.)
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;

  // Malformed/aborted connections are logged, never fatal.
  server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
    if (dev) console.warn("[server] client error:", err.code ?? err.message);
    if (socket.writable && !socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
    socket.destroy();
  });

  // Sweep tus uploads that were started and never finished. Without this the
  // store keeps every abandoned sidecar (and its partial payload) forever.
  const sweepExpiredUploads = () => {
    sweepTusUploads(tus)
      .then((n) => {
        if (n > 0) console.log(`[tus] swept ${n} stale upload record(s)`);
      })
      .catch((err) => console.error("[tus] cleanup failed:", err));
  };
  sweepExpiredUploads(); // clear whatever a previous run left behind
  // unref() so the timer never keeps the process alive on shutdown.
  setInterval(sweepExpiredUploads, TUS_CLEANUP_INTERVAL_MS).unref();

  // Purge trashed files once their retention window is up. Deliberately run
  // here rather than from a route: it deletes bytes and refunds quota, so it
  // must not be triggerable by a request, and it has to keep running on an
  // instance nobody is browsing.
  const sweepTrash = () => {
    purgeExpiredTrash()
      .then(({ deleted, bytes, skipped }) => {
        if (deleted > 0 || skipped > 0) {
          console.log(
            `[trash] purged ${deleted} expired item(s), ${bytes} byte(s) reclaimed, ${skipped} retried next sweep`,
          );
        }
      })
      .catch((err) => console.error("[trash] purge failed:", err));
  };
  // Delay the first pass so a boot loop can never turn into a delete loop, and
  // so startup is not competing with it for the database.
  setTimeout(sweepTrash, 60_000).unref();
  setInterval(sweepTrash, TRASH_SWEEP_INTERVAL_MS).unref();

  // Load the mail configuration once before traffic arrives. `requireEmailVerification`
  // is answered from this snapshot without awaiting (lib/mail-settings.ts), and
  // an unwarmed snapshot answers from the environment instead of the panel.
  void warmMailSettings();

  server.listen(config.port, () => {
    console.log(`> ${config.appName} ready on http://localhost:${config.port} (${dev ? "dev" : "prod"})`);
    reportRuntimeLimits();
  });
});

/**
 * Say, once, what this process thinks it is allowed to use.
 *
 * Every default Node picks is derived from the HOST, and this process runs in a
 * cgroup that grants a fraction of it: `nproc` reports the host's 6 cores
 * against a `cpus: 2.0` quota, and V8 sized its old space at 1120 MB inside a
 * 2 GiB container - enough for the heap alone to reach the limit while libvips
 * still holds half a gigabyte of pixels outside it.
 *
 * sharp is pinned in lib/media/sharp-runtime.ts (a module, so it applies
 * whichever graph loads first). The two settings that can only be chosen before
 * the process starts - the V8 heap and the libuv thread pool - live in
 * docker/entrypoint.sh; this log is how a mismatch becomes visible instead of
 * mysterious.
 */
function reportRuntimeLimits() {
  const cpu = cgroupCpuLimit();
  const mem = cgroupMemoryLimit();
  if (cpu == null && mem == null) return; // not containerised; nothing to report

  const heapMb = Math.round(v8.getHeapStatistics().heap_size_limit / (1024 * 1024));
  console.log(
    `> limits: cpu ${cpu ?? "unlimited"} core(s), memory ${
      mem ? `${Math.round(mem / (1024 * 1024))} MB` : "unlimited"
    }, libvips threads ${SHARP_CONCURRENCY}, v8 heap ${heapMb} MB, libuv pool ${
      process.env.UV_THREADPOOL_SIZE ?? "4 (default)"
    }`,
  );

  if (mem && heapMb * 1024 * 1024 > mem * 0.6) {
    console.warn(
      `> warning: V8 may grow its heap to ${heapMb} MB inside a ${Math.round(
        mem / (1024 * 1024),
      )} MB limit. Native image buffers live OUTSIDE that heap, so set --max-old-space-size (see docker/entrypoint.sh).`,
    );
  }
  if (mem && mem !== TRANSFORM_CONTAINER_MEMORY) {
    console.warn(
      `> warning: the transform budget is sized for ${Math.round(
        TRANSFORM_CONTAINER_MEMORY / (1024 * 1024),
      )} MB but this container has ${Math.round(
        mem / (1024 * 1024),
      )} MB. Update CONTAINER_MEMORY_BYTES in lib/media/transform-cost.ts.`,
    );
  }
}
