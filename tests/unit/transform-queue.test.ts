import { describe, it, expect } from "vitest";
import {
  AbortedError,
  BusyError,
  createLimiter,
  TimeoutError,
} from "@/lib/media/transform-queue";

/** A promise whose settling this test controls. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("the transform limiter", () => {
  it("runs up to the limit at once and makes the rest wait", async () => {
    const limiter = createLimiter({ limit: 2, queue: 4 });
    const gates = [deferred(), deferred(), deferred()];
    let started = 0;

    const jobs = gates.map((gate) =>
      limiter.run(async () => {
        started++;
        await gate.promise;
        return started;
      }),
    );

    // Two slots, so the third job has not been entered at all.
    await tick();
    expect(started).toBe(2);

    gates[0].resolve();
    await jobs[0];
    await tick();
    expect(started).toBe(3);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(jobs);
    expect(limiter.depth).toBe(0);
  });

  it("refuses rather than queueing without bound", async () => {
    // /convert is reachable by anyone holding a public link and costs seconds of
    // CPU, so an unbounded queue is just a slower way to fall over.
    const limiter = createLimiter({ limit: 1, queue: 1 });
    const gate = deferred();
    const running = limiter.run(() => gate.promise);
    const queued = limiter.run(async () => "queued");

    await expect(limiter.run(async () => "third")).rejects.toBeInstanceOf(BusyError);

    gate.resolve();
    await running;
    expect(await queued).toBe("queued");
  });

  it("hands the slot to the next waiter even when a job throws", async () => {
    const limiter = createLimiter({ limit: 1, queue: 2 });
    const gate = deferred();
    const failing = limiter.run(async () => {
      await gate.promise;
      throw new Error("encoder blew up");
    });
    const waiting = limiter.run(async () => "ran anyway");

    gate.resolve();
    await expect(failing).rejects.toThrow("encoder blew up");
    expect(await waiting).toBe("ran anyway");
    expect(limiter.depth).toBe(0);
  });

  it("never lets a fresh caller overtake the queue and oversubscribe", async () => {
    const limiter = createLimiter({ limit: 1, queue: 4 });
    const gate = deferred();
    let concurrent = 0;
    let peak = 0;

    const body = async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent--;
    };

    const first = limiter.run(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await gate.promise;
      concurrent--;
    });
    const second = limiter.run(body);
    gate.resolve();
    const third = limiter.run(body);

    await Promise.all([first, second, third]);
    expect(peak).toBe(1);
  });
});

describe("weights", () => {
  it("never lets the running jobs exceed the capacity", async () => {
    // Four units: two conversions (2 each), or four thumbnails, never both.
    const limiter = createLimiter({ limit: 4, queue: 8 });
    const gates = Array.from({ length: 6 }, () => deferred());
    let held = 0;
    let peak = 0;

    const jobs = gates.map((gate, i) => {
      const weight = i % 2 === 0 ? 2 : 1;
      return limiter.run(
        async () => {
          held += weight;
          peak = Math.max(peak, held);
          await gate.promise;
          held -= weight;
        },
        { weight },
      );
    });

    await tick();
    expect(peak).toBeLessThanOrEqual(4);
    gates.forEach((g) => g.resolve());
    await Promise.all(jobs);
    expect(limiter.used).toBe(0);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("does not let light jobs starve a heavy one waiting in front of them", async () => {
    const limiter = createLimiter({ limit: 2, queue: 4 });
    const running = deferred();
    const heavyGate = deferred();
    const order: string[] = [];

    const first = limiter.run(() => running.promise, { weight: 1 });
    // Needs both units, so it must wait...
    const heavy = limiter.run(
      async () => {
        order.push("heavy");
        await heavyGate.promise;
      },
      { weight: 2 },
    );
    // ...and this one fits in the free unit, but is behind it in the queue.
    const light = limiter.run(async () => {
      order.push("light");
    });

    running.resolve();
    await first;
    await tick();
    expect(order).toEqual(["heavy"]);

    heavyGate.resolve();
    await Promise.all([heavy, light]);
    expect(order).toEqual(["heavy", "light"]);
  });
});

describe("cancellation", () => {
  it("refuses a caller that has already gone away", async () => {
    const limiter = createLimiter({ limit: 1, queue: 1 });
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    await expect(
      limiter.run(
        async () => {
          ran = true;
        },
        { signal: ac.signal },
      ),
    ).rejects.toBeInstanceOf(AbortedError);
    expect(ran).toBe(false);
    expect(limiter.depth).toBe(0);
  });

  it("drops a queued job when its caller hangs up, and frees the queue slot", async () => {
    // The scenario that made holding the box at full load free: fire two slots
    // plus six queued conversions, close every socket, and the server used to
    // work through all eight anyway.
    const limiter = createLimiter({ limit: 1, queue: 2 });
    const gate = deferred();
    const running = limiter.run(() => gate.promise);

    const ac = new AbortController();
    let queuedRan = false;
    const queued = limiter.run(
      async () => {
        queuedRan = true;
      },
      { signal: ac.signal },
    );

    await tick();
    expect(limiter.depth).toBe(2);

    ac.abort();
    await expect(queued).rejects.toBeInstanceOf(AbortedError);
    expect(limiter.depth).toBe(1); // the abandoned waiter is gone, not merely ignored

    gate.resolve();
    await running;
    expect(queuedRan).toBe(false);
  });

  it("passes a signal into the job so a running one can bail out at a checkpoint", async () => {
    const limiter = createLimiter({ limit: 1, queue: 1 });
    const ac = new AbortController();
    const started = deferred();

    const job = limiter.run(
      async (signal) => {
        started.resolve();
        await tick();
        if (signal.aborted) throw new AbortedError();
        return "finished";
      },
      { signal: ac.signal },
    );

    await started.promise;
    ac.abort();
    await expect(job).rejects.toBeInstanceOf(AbortedError);
    // The accounting follows the job's own promise, one microtask behind the
    // answer the caller got. That ordering is deliberate — see the deadline test.
    await tick();
    expect(limiter.depth).toBe(0);
  });
});

describe("deadlines", () => {
  it("gives up on the caller's behalf but keeps the slot until the work really ends", async () => {
    // libvips cannot always be interrupted (measured: a single-frame AVIF encode
    // runs its full course with a timeout set). Releasing the slot at the
    // deadline would let a fresh caller start while the abandoned job still
    // holds its memory - the one thing the limiter exists to prevent.
    const limiter = createLimiter({ limit: 1, queue: 1 });
    const stubborn = deferred();

    const job = limiter.run(() => stubborn.promise, { timeoutMs: 10 });
    await expect(job).rejects.toBeInstanceOf(TimeoutError);

    // Still held: the work has not finished.
    expect(limiter.used).toBe(1);
    // ...and the deadline covers the WAIT as well, so a caller queued behind an
    // uninterruptible job is not stuck for as long as that job takes.
    await expect(limiter.run(async () => "next", { timeoutMs: 10 })).rejects.toBeInstanceOf(
      TimeoutError,
    );

    stubborn.resolve();
    await tick();
    expect(limiter.used).toBe(0);
    expect(limiter.depth).toBe(0);
  });

  it("returns the value when the work beats the deadline", async () => {
    const limiter = createLimiter({ limit: 1, queue: 1 });
    expect(await limiter.run(async () => "quick", { timeoutMs: 1000 })).toBe("quick");
    expect(limiter.depth).toBe(0);
  });
});
