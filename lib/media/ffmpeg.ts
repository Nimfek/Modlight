/**
 * Running ffmpeg on files other people uploaded.
 *
 * Everything here exists because the input is hostile. ffmpeg is a demuxer zoo
 * with a URL parser bolted on, and its defaults are tuned for a person at a
 * terminal converting their own holiday video, not for a public HTTP endpoint on
 * a box shared with sixteen other stacks.
 *
 * The four defaults that had to be reversed, each verified against ffmpeg 5.1.9
 * in the runtime image rather than assumed:
 *
 *  1. PROTOCOLS. `-protocol_whitelist file,pipe` - anything else and a crafted
 *     file can make ffmpeg fetch a URL for us. Measured: `-i http://…` is
 *     refused with "Protocol 'http' not on whitelist", by ffmpeg and ffprobe
 *     alike.
 *
 *  2. DEMUXER AUTODETECTION. This is the one that actually bites. Handed a text
 *     file containing `ffconcat version 1.0 / file /tmp/secret.txt`, ffmpeg with
 *     no `-f` picks the CONCAT demuxer and tries to read that path; only the
 *     `-safe` default stopped it ("Unsafe file name"). One `-safe 0` anywhere in
 *     the argument list, or a demuxer whose safety check is weaker, and that is
 *     local file disclosure. So the container is never inferred: `probeAv` reads
 *     it, an allowlist approves it, and it is FORCED with `-f`. Measured: the
 *     same evil file under `-f mov` dies at "moov atom not found".
 *     Note also that `-f lavfi` needs no protocol at all - the whitelist would
 *     not have saved us there either. Forcing the format is the load-bearing
 *     guard; the whitelist is depth behind it.
 *
 *  3. MOV DATA REFERENCES. An .mp4 can name its media data in another file.
 *     `use_absolute_path` defaults to false (confirmed in `-h demuxer=mov`:
 *     "this is a possible security issue (default false)"), so a dref can only
 *     reach paths relative to the input - which is the uploader's own storage
 *     directory. Passed explicitly anyway, because a default is a decision
 *     someone else is free to revisit.
 *
 *  4. LIFETIME. ffmpeg spawns worker threads; killing the parent leaves them
 *     running. Every process starts its own process GROUP and the timeout kills
 *     the group. A runaway encoder on a two-core container is not a leak, it is
 *     an outage.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { effectiveCpuCount } from "@/lib/runtime/limits";

/** Overridable so a dev box can point at a local build; the image ships both. */
const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH || "ffprobe";

/** Only ever these two. Nothing here takes a program name from a caller. */
export type AvTool = "ffmpeg" | "ffprobe";

function binaryFor(tool: AvTool): string {
  return tool === "ffmpeg" ? FFMPEG_BIN : FFPROBE_BIN;
}

/**
 * Head of stderr kept for diagnosis. ffmpeg is chatty and the interesting line
 * is always near the top; keeping the whole stream would let a crafted file
 * write unbounded data into our memory through its error messages.
 */
export const STDERR_LIMIT = 8 * 1024;

/** Ceiling on anything we collect from stdout (ffprobe JSON). */
export const STDOUT_LIMIT = 512 * 1024;

/**
 * Append at most what is left of a budget.
 *
 * The obvious form of this - `if (buf.length < LIMIT) buf += chunk` - is not a
 * bound at all: it checks BEFORE appending, so one chunk arriving under the
 * limit can carry the total arbitrarily past it. A pipe hands over whatever has
 * accumulated, so 64 KB of ffmpeg warnings arrived as a single chunk and the
 * 8 KB cap admitted all of it. Caught by a test that had to run on a loaded
 * machine to see the coalescing.
 */
function appendBounded(current: string, chunk: string, limit: number): string {
  if (current.length >= limit) return current;
  return current + chunk.slice(0, limit - current.length);
}

export class AvToolError extends Error {
  constructor(
    readonly tool: AvTool,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`${tool} exited with ${code ?? "signal"}: ${stderr.slice(0, 400)}`);
    this.name = "AvToolError";
  }
}

/** The job ran past its deadline and its process group was killed. */
export class AvTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`ffmpeg exceeded ${ms} ms and was killed`);
    this.name = "AvTimeoutError";
  }
}

/** The caller went away; the process group was killed for the same reason. */
export class AvAbortedError extends Error {
  constructor() {
    super("ffmpeg abandoned by the caller");
    this.name = "AvAbortedError";
  }
}

export interface RunAvOptions {
  /** Hard wall clock. On expiry the whole process GROUP is killed. */
  timeoutMs: number;
  /** Caller's signal; abort kills the group the same way a timeout does. */
  signal?: AbortSignal;
  /** Collect stdout (ffprobe JSON). Off for ffmpeg, which writes to a file. */
  captureStdout?: boolean;
}

export interface AvResult {
  stdout: string;
  stderr: string;
}

/**
 * Kill a whole process tree.
 *
 * On POSIX the child is spawned `detached`, which makes it a process group
 * leader, so the negative pid reaches its children too. Windows has no process
 * groups in that sense - `taskkill /T` is the equivalent, and it is only ever
 * reached on a developer machine, never in the container.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null || child.exitCode != null || child.signalCode != null) return;

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }

  try {
    // The group, not the leader. SIGKILL rather than SIGTERM: this path is only
    // reached once the deadline has already passed, and an encoder that has
    // ignored its deadline has forfeited the chance to shut down tidily.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run one of the two tools with an argument ARRAY.
 *
 * `shell` is never set, so no argument is ever parsed by a shell: a filename
 * containing `;` or `$(…)` is a filename. Callers build their arguments from
 * fixed strings plus values that have been through the allowlists in
 * av-targets.ts, and paths that come from our own storage driver.
 */
export function runAvTool(
  tool: AvTool,
  args: string[],
  opts: RunAvOptions,
): Promise<AvResult> {
  return new Promise<AvResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binaryFor(tool), args, {
        // The whole point: no shell, so nothing in `args` can become syntax.
        shell: false,
        // Own process group, so the timeout can take the children with it.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        // Inherit nothing that could redirect the tool. ffmpeg reads a handful
        // of variables (FFREPORT writes a log file wherever it is pointed), and
        // this process's environment holds database and mail credentials that a
        // media converter has no reason to see.
        // The cast is only about Next augmenting ProcessEnv with required keys;
        // the point is that PATH really is the only variable handed over.
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        } as unknown as NodeJS.ProcessEnv,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let outcome: Error | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer = setTimeout(() => {
      outcome = new AvTimeoutError(opts.timeoutMs);
      killTree(child);
    }, opts.timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      outcome = new AvAbortedError();
      killTree(child);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    if (opts.signal?.aborted) {
      onAbort();
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (!opts.captureStdout) return;
      stdout = appendBounded(stdout, chunk, STDOUT_LIMIT);
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, STDERR_LIMIT);
    });

    child.on("error", (err) => {
      finish(() => reject(outcome ?? err));
    });

    child.on("close", (code) => {
      finish(() => {
        // A deadline or an abort is the REAL reason, even though what we
        // observed is a process that died of SIGKILL. Reporting the signal
        // would turn "took too long" into "conversion failed".
        if (outcome) {
          reject(outcome);
          return;
        }
        if (code !== 0) {
          reject(new AvToolError(tool, code, stderr));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  });
}

/**
 * Arguments every ffmpeg/ffprobe invocation starts with.
 *
 * `container` is the demuxer name, and it must come from the allowlist in
 * av-targets.ts - see point 2 in the header. Passing null is only correct for
 * the probe that DISCOVERS the container, which is why that call is the one
 * place in the codebase allowed to omit it.
 */
export function inputArgs(
  path: string,
  container: string | null,
  /**
   * Options that must sit BEFORE `-i` to apply to the input - `-ss` above all,
   * where the placement is the difference between seeking to a keyframe and
   * decoding the whole file up to that point.
   */
  beforeInput: string[] = [],
): string[] {
  return [
    "-nostdin",
    "-protocol_whitelist",
    "file,pipe",
    ...(container ? ["-f", container] : []),
    // Demuxer-PRIVATE option: ffmpeg resolves it against the chosen demuxer's
    // option table and exits with "Option not found" if that demuxer has no such
    // knob. So it may only be passed for the family that owns it, which is also
    // the only family that has data references to confine.
    ...(container === "mov" ? ["-use_absolute_path", "0"] : []),
    ...beforeInput,
    "-i",
    path,
  ];
}

/** Probe arguments: same guards, but ffprobe takes its input positionally. */
export function probeInputArgs(path: string): string[] {
  return ["-protocol_whitelist", "file,pipe", "-i", path];
}

/**
 * Threads one ffmpeg job may use.
 *
 * The cgroup number, not `nproc` - inside the container those disagree 2 vs 6
 * (lib/runtime/limits.ts). Handing an encoder six threads on a two-core quota
 * does not make it faster, it makes the scheduler throttle the whole cgroup and
 * every other request on the box slower with it.
 */
export function threadArgs(): string[] {
  return ["-threads", String(effectiveCpuCount())];
}

/** Is ffmpeg actually present? Cached: the answer cannot change under us. */
let available: Promise<boolean> | null = null;

export function ffmpegAvailable(): Promise<boolean> {
  available ??= runAvTool("ffprobe", ["-version"], { timeoutMs: 5_000, captureStdout: true })
    .then(() => true)
    .catch(() => false);
  return available;
}
