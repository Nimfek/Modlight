/**
 * What THIS process is actually allowed to use.
 *
 * Everything Node sizes itself by looks at the HOST. `os.cpus().length` reports
 * 6 inside our container (measured: `docker exec modlight nproc` -> 6) while the
 * cgroup grants `cpus: 2.0`, and V8 picks a heap ceiling from total system RAM
 * rather than from `memory.max` (measured: 1120 MB of old space inside a 2 GiB
 * container). Both defaults are wrong in the same direction - they let the
 * process believe it owns a machine it shares with ~16 other stacks.
 *
 * The numbers below come from cgroup v2, which is what the host runs. Parsing is
 * separated from reading so the interesting part is a unit test rather than a
 * production surprise.
 */

import { readFileSync } from "node:fs";
import os from "node:os";

/** cgroup v2 files. v1 is not handled: the host is v2 and a wrong guess is worse than a fallback. */
const CPU_MAX = "/sys/fs/cgroup/cpu.max";
const MEMORY_MAX = "/sys/fs/cgroup/memory.max";

/**
 * Parse `cpu.max`: "<quota> <period>", or "max <period>" when uncapped.
 *
 * Returns cores as a float (200000/100000 -> 2), or null when there is no cap.
 */
export function parseCpuMax(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const [quota, period] = raw.trim().split(/\s+/);
  if (!quota || quota === "max") return null;
  const q = Number(quota);
  const p = Number(period ?? "100000");
  if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
  return q / p;
}

/** Parse `memory.max`: a byte count, or "max" when uncapped. */
export function parseMemoryMax(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (t === "max") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Cores this process may burn, from the cgroup; null outside a capped container. */
export function cgroupCpuLimit(): number | null {
  return parseCpuMax(read(CPU_MAX));
}

/** Bytes this process may hold, from the cgroup; null outside a capped container. */
export function cgroupMemoryLimit(): number | null {
  return parseMemoryMax(read(MEMORY_MAX));
}

/**
 * How many cores to size thread pools by: the cgroup quota when there is one,
 * the host count otherwise, never below 1.
 *
 * Rounded DOWN, deliberately. Handing libvips more threads than the quota does
 * not buy throughput - the scheduler simply throttles the cgroup and every
 * request gets slower together, which is the failure this whole round is about.
 */
export function effectiveCpuCount(): number {
  const quota = cgroupCpuLimit();
  const host = os.cpus().length || 1;
  if (quota == null) return Math.max(1, host);
  return Math.max(1, Math.min(host, Math.floor(quota)));
}
