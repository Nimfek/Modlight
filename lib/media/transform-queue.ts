/**
 * The one gate every expensive media operation goes through.
 *
 * Thumbnails, format conversion and (next) video transcoding all decode
 * attacker-supplied files with native code on a container that is allowed two
 * cores and 2 GiB. `/convert` is reachable by anyone holding a public link, so
 * "how many of these may run at once" cannot be answered per feature - it has to
 * be answered once, for all of them, or the next feature quietly doubles the
 * ceiling the previous one was sized against.
 *
 * Three properties, and each one exists because its absence was a real hole:
 *
 *  1. WEIGHTED capacity. One limiter, as it must be, but a 39 ms thumbnail must
 *     not queue behind two 5 s AVIF encodes for a slot it barely uses. The
 *     weights and the pool they divide are in lib/media/transform-cost.ts.
 *
 *  2. CANCELLATION. A caller that has gone away is not worth working for. Eight
 *     requests fired at /convert (two slots plus six queue) and then abandoned
 *     used to be eight jobs that ran to completion against nobody, which made
 *     holding the box at full load free. Aborting while queued is exact; a job
 *     already inside libvips can only be asked (see the deadline note below).
 *
 *  3. A DEADLINE on the response. The slot is released when the work really
 *     ends, never when the deadline fires - releasing early would let a fresh
 *     caller start while the abandoned job still holds its memory, which is the
 *     one thing the limiter exists to prevent.
 *
 * Deliberately in-process and dependency-free: there is exactly one Node process
 * behind the proxy, so a counter is the whole mechanism.
 */

import { TRANSFORM_CAPACITY, TRANSFORM_QUEUE } from "@/lib/media/transform-cost";

/** No slot, and no room to wait for one. The caller should retry later (429/503). */
export class BusyError extends Error {
  constructor() {
    super("Too many transforms in progress.");
    this.name = "BusyError";
  }
}

/** The caller went away (socket closed) before the work could start or finish. */
export class AbortedError extends Error {
  constructor() {
    super("Transform abandoned by the caller.");
    this.name = "AbortedError";
  }
}

/** The work outlived its deadline. The response gives up; the job may not have. */
export class TimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`Transform exceeded ${ms} ms.`);
    this.name = "TimeoutError";
  }
}

export interface LimiterOptions {
  /** Total capacity, in weight units. */
  limit: number;
  /** How many callers may wait for capacity before further ones are refused. */
  queue: number;
}

export interface RunOptions {
  /** Units of capacity this job occupies (default 1). Clamped to `limit`. */
  weight?: number;
  /** Wall clock after which the CALLER stops waiting. */
  timeoutMs?: number;
  /** The request's signal, so an abandoned job is dropped rather than performed. */
  signal?: AbortSignal;
}

export interface Limiter {
  run<T>(fn: (signal: AbortSignal) => Promise<T>, opts?: RunOptions): Promise<T>;
  /** Running + waiting jobs, for tests and diagnostics. */
  readonly depth: number;
  /** Capacity units currently held, for tests and diagnostics. */
  readonly used: number;
}

interface Waiter {
  weight: number;
  admit: () => void;
  reject: (err: Error) => void;
  /** Detaches the abort listener; called on either outcome. */
  cleanup: () => void;
}

export function createLimiter({ limit, queue }: LimiterOptions): Limiter {
  let used = 0;
  let running = 0;
  const waiting: Waiter[] = [];

  /**
   * Admit whoever is at the FRONT and fits, and only from the front.
   *
   * Skipping a waiter that does not fit in favour of a lighter one behind it
   * would starve every heavy job the moment thumbnails are flowing: a conversion
   * would never see two free units again.
   */
  const drain = () => {
    while (waiting.length > 0 && used + waiting[0].weight <= limit) {
      const next = waiting.shift()!;
      used += next.weight;
      next.cleanup();
      next.admit();
    }
  };

  const release = (weight: number) => {
    used -= weight;
    drain();
  };

  /**
   * `giveUp` is the COMBINED signal: the caller hanging up and the deadline
   * expiring both land on it. Queueing has to be covered by the deadline too -
   * a caller stuck behind a job libvips will not interrupt would otherwise wait
   * for as long as that job takes, with its own timeout not yet started.
   */
  const acquire = async (weight: number, giveUp: AbortSignal): Promise<void> => {
    // New callers never overtake the queue: admitting one because it happens to
    // fit would put more work in flight than the limit allows and push the
    // waiters further back every time.
    if (waiting.length === 0 && used + weight <= limit) {
      used += weight;
      return;
    }
    if (waiting.length >= queue) throw new BusyError();

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        weight,
        admit: resolve,
        reject,
        cleanup: () => giveUp.removeEventListener("abort", onAbort),
      };
      function onAbort() {
        const i = waiting.indexOf(waiter);
        if (i < 0) return; // already admitted; the caller below handles it
        waiting.splice(i, 1);
        waiter.cleanup();
        waiter.reject(asError(giveUp.reason));
      }
      giveUp.addEventListener("abort", onAbort, { once: true });
      waiting.push(waiter);
    });

    // Admitted - but the caller may have hung up in the very same tick.
    if (giveUp.aborted) {
      release(weight);
      throw asError(giveUp.reason);
    }
  };

  return {
    get depth() {
      return running + waiting.length;
    },
    get used() {
      return used;
    },
    async run<T>(fn: (signal: AbortSignal) => Promise<T>, opts: RunOptions = {}): Promise<T> {
      const weight = Math.min(Math.max(1, opts.weight ?? 1), limit);
      const outer = opts.signal;
      if (outer?.aborted) throw new AbortedError();

      // One controller for the whole call: it covers the wait for a slot AND the
      // work itself, and it carries WHY (TimeoutError vs AbortedError) so the
      // route can answer 503 or 499 without guessing.
      const deadline = new AbortController();
      const timer =
        opts.timeoutMs != null
          ? setTimeout(() => deadline.abort(new TimeoutError(opts.timeoutMs!)), opts.timeoutMs)
          : null;
      // A timer must never be the reason the process stays alive.
      timer?.unref?.();
      const relay = () => deadline.abort(new AbortedError());
      outer?.addEventListener("abort", relay, { once: true });
      const detach = () => {
        if (timer) clearTimeout(timer);
        outer?.removeEventListener("abort", relay);
      };

      try {
        await acquire(weight, deadline.signal);
      } catch (err) {
        detach();
        throw err;
      }

      // From here the slot is held until `fn` really settles.
      running++;
      let work: Promise<T>;
      try {
        work = fn(deadline.signal);
      } catch (err) {
        // A synchronous throw still has to give the slot back.
        running--;
        detach();
        release(weight);
        throw err;
      }

      // Accounting follows the REAL end of the work, not what the caller is told.
      void work.catch(() => {}).finally(() => {
        running--;
        detach();
        release(weight);
      });

      if (timer == null && !outer) return work;

      // The caller waits only until the deadline. A job that cannot be
      // interrupted (libvips does not always come back to its progress callback)
      // still finishes - it just finishes with nobody on the other end.
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          if (deadline.signal.aborted) {
            reject(asError(deadline.signal.reason));
            return;
          }
          deadline.signal.addEventListener(
            "abort",
            () => reject(asError(deadline.signal.reason)),
            { once: true },
          );
        }),
      ]);
    },
  };
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new AbortedError();
}

/**
 * The shared limiter. Capacity, weights and queue depth are derived in
 * lib/media/transform-cost.ts from the container's real memory limit.
 */
export const imageTransforms = createLimiter({
  limit: TRANSFORM_CAPACITY,
  queue: TRANSFORM_QUEUE,
});
