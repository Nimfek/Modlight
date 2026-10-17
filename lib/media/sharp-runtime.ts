/**
 * Size libvips to the cgroup, once, before anything decodes a picture.
 *
 * sharp reads `os.cpus().length` to pick its thread count, and inside the
 * production container that returns 6 (the host) against a `cpus: 2.0` quota.
 * Six libvips worker threads on a two-core slice do not go faster; they take
 * three times as long to be scheduled, hold three times as many strip buffers
 * while they wait, and drag every other request on the box down with them.
 *
 * Importing this module applies the setting. Every path that touches sharp
 * imports it (lib/media/probe.ts, image.ts, convert.ts), so it is applied
 * whichever module graph runs first - the custom server, a Next route handler,
 * or a script - without a boot-order rule anybody has to remember.
 */

import sharp from "sharp";
import { cgroupMemoryLimit, effectiveCpuCount } from "@/lib/runtime/limits";

/** Threads libvips may use per operation. */
export const SHARP_CONCURRENCY = effectiveCpuCount();

/** Memory ceiling this process runs under, or null when it is not capped. */
export const MEMORY_LIMIT_BYTES = cgroupMemoryLimit();

sharp.concurrency(SHARP_CONCURRENCY);

// libvips also keeps an operation cache. The defaults (50 MB / 20 files / 100
// items) are sane for a server that re-reads the same few pictures; ours reads a
// different file almost every time, so the cache is close to pure overhead.
// Files are what matter most: a cached open descriptor pins the whole decoder
// state, and `pids_limit: 512` is not a lot of room to waste.
sharp.cache({ memory: 32, files: 10, items: 50 });

export { sharp };
