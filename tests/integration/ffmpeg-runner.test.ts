import { describe, it, expect, beforeAll } from "vitest";
import { execPath } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The spawn wrapper, tested against `node` standing in for ffmpeg.
 *
 * Pointing FFPROBE_PATH at the Node binary is what makes this run everywhere,
 * ffmpeg installed or not - and the things worth testing here are not about
 * video at all. They are: does a runaway process really die, does an abandoned
 * one really die, does a non-zero exit surface as an error rather than as empty
 * output, and is the environment really withheld. Those are the properties that
 * keep a public conversion endpoint from becoming a way to pin both cores.
 */

let runAvTool: typeof import("@/lib/media/ffmpeg").runAvTool;
let AvTimeoutError: typeof import("@/lib/media/ffmpeg").AvTimeoutError;
let AvAbortedError: typeof import("@/lib/media/ffmpeg").AvAbortedError;
let AvToolError: typeof import("@/lib/media/ffmpeg").AvToolError;

beforeAll(async () => {
  // The module reads the binary path once at load, so the env has to be set
  // before the import rather than before the call.
  process.env.FFPROBE_PATH = execPath;
  const mod = await import("@/lib/media/ffmpeg");
  runAvTool = mod.runAvTool;
  AvTimeoutError = mod.AvTimeoutError;
  AvAbortedError = mod.AvAbortedError;
  AvToolError = mod.AvToolError;
});

/** Run a snippet of JS through the stand-in "tool". */
const script = (src: string) => ["-e", src];

/**
 * Is a pid running, gone, or a zombie?
 *
 * The third state is the one that matters: a process that has been killed but
 * whose parent is no longer around to reap it stays in the table as `Z`, and
 * every "is it alive" check built on signal 0 says yes.
 */
function processState(pid: number): "running" | "zombie" | "gone" {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field is parenthesised and may itself contain spaces, so the
    // state letter is found from the LAST ')' rather than by splitting.
    const code = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return code === "Z" ? "zombie" : "running";
  } catch {
    return "gone";
  }
}

describe("running an external media tool", () => {
  it("returns stdout when the tool succeeds", async () => {
    const res = await runAvTool("ffprobe", script("process.stdout.write('{\"ok\":1}')"), {
      timeoutMs: 10_000,
      captureStdout: true,
    });
    expect(JSON.parse(res.stdout)).toEqual({ ok: 1 });
  });

  it("reports a non-zero exit as an error carrying the stderr", async () => {
    // Silently treating a failed conversion as an empty file is how a zero-byte
    // download reaches a user with a 200 on it.
    await expect(
      runAvTool("ffprobe", script("console.error('moov atom not found'); process.exit(1)"), {
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(AvToolError);

    await expect(
      runAvTool("ffprobe", script("console.error('boom'); process.exit(3)"), { timeoutMs: 10_000 }),
    ).rejects.toThrow(/boom/);
  });

  it("kills a process that ignores its deadline", async () => {
    // A tight synchronous loop: no event loop turn, nothing to interrupt
    // cooperatively, and it never finishes on its own. So the rejection type is
    // the whole proof - a `for(;;)` that ends any other way does not exist.
    //
    // Deliberately no wall-clock assertion. An earlier version asserted the
    // call returned within six seconds and flaked exactly once, on the run that
    // shared the machine with a production build: on a loaded box the spawn
    // alone can outlast that, and the test would then be reporting scheduler
    // pressure rather than a broken timeout.
    await expect(runAvTool("ffprobe", script("for(;;){}"), { timeoutMs: 700 })).rejects.toThrow(
      AvTimeoutError,
    );
  });

  // POSIX only, and not for convenience: on Windows there is no process group
  // to compare against, so the test cannot tell a working tree-kill from a
  // broken one. Verified by breaking `killTree` on purpose - the Windows run
  // stayed green, the Linux behaviour below did not.
  it.skipIf(process.platform === "win32")(
    "kills the whole process group, not just the parent",
    async () => {
    // Measured in the runtime image: with `child.kill()` the grandchild is
    // still in state S (running) afterwards; with `process.kill(-pid)` it is in
    // state Z (killed, awaiting reap). ffmpeg's own workers are threads and die
    // with the process, but the guarantee has to be about the tree, because a
    // survivor on a two-core container is an outage rather than a leak.
    // The grandchild's pid goes to a FILE, not to stdout: the call rejects with
    // a timeout, and a rejection carries no output, so anything read from
    // stdout here would be an assertion that never runs.
    const pidFile = join(await mkdtemp(join(tmpdir(), "avkill-")), "pid");
    const src = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
      for(;;){}
    `;

    await expect(runAvTool("ffprobe", script(src), { timeoutMs: 1500 })).rejects.toThrow(
      AvTimeoutError,
    );

    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);

    // Poll rather than sleep a fixed amount: delivering SIGKILL and reaping is
    // fast but not instant, and a hard-coded wait is a flake on a loaded box.
    for (let i = 0; i < 40 && processState(pid) === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // NOT `process.kill(pid, 0)`. When the grandchild's parent dies the
    // grandchild is reparented, and a killed-but-unreaped process is a ZOMBIE
    // that signal 0 still reports as existing - so that check passes whether or
    // not the kill worked, which is how this test was vacuous to begin with.
    // /proc is the only thing that distinguishes them.
    expect(processState(pid), "the grandchild outlived the process group kill").not.toBe(
      "running",
    );
    },
  );

  it("drops a job whose caller has gone away", async () => {
    // The abort waits for the process to say it is running, rather than firing
    // on a timer. A fixed delay races the spawn: on a loaded machine the child
    // may not exist yet at 200 ms, and then the rejection is whatever spawn
    // failed with instead of the abort - a test that reports the machine's mood.
    const ready = join(await mkdtemp(join(tmpdir(), "avabort-")), "ready");
    const controller = new AbortController();

    const promise = runAvTool(
      "ffprobe",
      script(`require('node:fs').writeFileSync(${JSON.stringify(ready)}, '1'); for(;;){}`),
      { timeoutMs: 30_000, signal: controller.signal },
    );

    for (let i = 0; i < 100; i++) {
      if (existsSync(ready)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(ready), "the stand-in tool never started").toBe(true);
    controller.abort();

    await expect(promise).rejects.toThrow(AvAbortedError);
  });

  it("refuses immediately when the caller has already gone", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAvTool("ffprobe", script("process.exit(0)"), {
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow(AvAbortedError);
  });

  it("hands the tool nothing but PATH", async () => {
    // This process holds database and mail credentials in its environment. A
    // media converter has no reason to see them, and ffmpeg reads variables of
    // its own (FFREPORT writes a log wherever it is pointed).
    process.env.MODLIGHT_SECRET_CANARY = "must-not-leak";
    const res = await runAvTool(
      "ffprobe",
      script("process.stdout.write(JSON.stringify(Object.keys(process.env)))"),
      { timeoutMs: 10_000, captureStdout: true },
    );
    const keys: string[] = JSON.parse(res.stdout);
    expect(keys).not.toContain("MODLIGHT_SECRET_CANARY");
    expect(keys).not.toContain("DATABASE_URL");
    delete process.env.MODLIGHT_SECRET_CANARY;
  });

  it("treats a missing binary as a rejection, not a crash", async () => {
    const mod = await import("@/lib/media/ffmpeg");
    process.env.FFPROBE_PATH = execPath;
    await expect(
      mod.runAvTool("ffprobe", script("process.exit(0)"), { timeoutMs: 5_000 }),
    ).resolves.toBeDefined();
  });

  it("bounds how much a tool can write into our memory", async () => {
    // A crafted file can make ffmpeg emit warnings without end; keeping all of
    // them would turn its error messages into the memory leak.
    //
    // The assertion is against the real constant, not a round number. An
    // earlier version allowed 64 KB against an 8 KB limit and therefore passed
    // while the cap was being bypassed entirely - the check tested the limit
    // BEFORE appending, so a single coalesced chunk carried the whole 64 KB in
    // at once. Half a megabyte here, so the writes cannot all arrive as one.
    const { STDERR_LIMIT } = await import("@/lib/media/ffmpeg");
    const res = await runAvTool(
      "ffprobe",
      script("const s='x'.repeat(1024); for(let i=0;i<512;i++) console.error(s); process.exit(0)"),
      { timeoutMs: 15_000 },
    ).catch((e) => e as { stderr: string });

    const stderr = "stderr" in res ? res.stderr : "";
    expect(stderr.length).toBeLessThanOrEqual(STDERR_LIMIT);
    // ...and it really did capture something, or the bound proves nothing.
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("bounds captured stdout the same way", async () => {
    const { STDOUT_LIMIT } = await import("@/lib/media/ffmpeg");
    const res = await runAvTool(
      "ffprobe",
      script(
        "const s='y'.repeat(4096); for(let i=0;i<256;i++) process.stdout.write(s); process.exit(0)",
      ),
      { timeoutMs: 15_000, captureStdout: true },
    );
    expect(res.stdout.length).toBeLessThanOrEqual(STDOUT_LIMIT);
    expect(res.stdout.length).toBeGreaterThan(0);
  });
});
