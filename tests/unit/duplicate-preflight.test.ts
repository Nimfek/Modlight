import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { preflightDuplicates } from "@/components/upload/duplicate-preflight";
import {
  canHash,
  HASH_MAX_BATCH_BYTES,
  HASH_MAX_FILE_BYTES,
  isHashable,
  sha256Hex,
} from "@/components/upload/checksum";
import { MAX_CHECKSUMS, type CheckResponse } from "@/lib/upload/duplicate-check";

/**
 * The browser half of the duplicate check.
 *
 * Two properties matter here and neither is visible from the server tests.
 *
 * The first is that the two halves agree on what a checksum IS. The client
 * hashes with WebCrypto and the server with `node:crypto`; if those ever
 * disagreed on encoding or case, nothing would match, no duplicate would ever be
 * reported, and the whole feature would fail SILENTLY - which is the only way a
 * feature like this can fail, since "no duplicates found" is also what a clean
 * library looks like.
 *
 * The second is that the check can never stop an upload. A missing digest, a
 * request that 500s, a network that dies, a body that does not parse: every one
 * of those has to come back as "nothing to report", because none of them is
 * evidence about a file and all of them sit in front of the thing the user
 * actually asked for.
 */

/** A Blob of `size` bytes with deterministic contents. */
function blob(size: number, seed = 7): Blob {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) % 256;
  return new Blob([bytes]);
}

function input(id: string, size: number, seed = 7) {
  return { id, name: `${id}.bin`, size, data: blob(size, seed) };
}

/** What the route would answer, in the shape the client parses. */
function answer(partial: Partial<CheckResponse> & Pick<CheckResponse, "results">): CheckResponse {
  return { message: "OK", requested: partial.results.length, unchecksummed: 0, truncated: false, ...partial };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Reply with a JSON body, as `fetch` would. */
function replies(body: unknown, ok = true) {
  fetchMock.mockResolvedValue({ ok, json: async () => body } as unknown as Response);
}

/** Answer whatever is asked with "new", so `checked` means something. */
function repliesAllNew() {
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { checksums } = JSON.parse(String(init.body)) as { checksums: string[] };
    return {
      ok: true,
      json: async () =>
        answer({ results: checksums.map((c) => ({ checksum: c, status: "new" as const, matches: [] })) }),
    } as unknown as Response;
  });
}

/** The single checksum the last request asked about. */
function askedFor(): string[] {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return (JSON.parse(String(init.body)) as { checksums: string[] }).checksums;
}

/* -------------------------------------------------------------------------- */
/* The digest itself                                                           */
/* -------------------------------------------------------------------------- */

describe("sha256Hex", () => {
  it("produces exactly what the server writes into uploads.checksum", async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const mine = await sha256Hex(new Blob([bytes]));
    // The literal comparison against node:crypto is the point: `lib/upload/
    // sharex.ts` and `app/actions/pastes.ts` both store
    // `createHash("sha256").update(...).digest("hex")`, and a client that
    // encoded its digest differently would match nothing, forever, quietly.
    expect(mine).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(mine).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes an empty blob without inventing a value", async () => {
    expect(await sha256Hex(new Blob([]))).toBe(createHash("sha256").update("").digest("hex"));
  });
});

describe("canHash", () => {
  it("reports a secure context honestly", () => {
    expect(canHash()).toBe(true);
    // A panel reached over plain http on a LAN address has no `crypto.subtle`
    // at all. Asserted on the predicate itself because the early return it
    // guards is a shortcut, not a behaviour: with it removed, every digest
    // throws and is swallowed per file, and the OUTCOME is identical (see the
    // test below). What the shortcut buys is not attempting 400 digests that
    // cannot work, which is a cost, not a contract.
    vi.stubGlobal("crypto", {});
    expect(canHash()).toBe(false);
    vi.stubGlobal("crypto", { subtle: {} });
    expect(canHash()).toBe(false);
  });
});

describe("isHashable", () => {
  it("takes a screenshot and leaves a screen recording alone", () => {
    expect(isHashable(200 * 1024)).toBe(true);
    expect(isHashable(HASH_MAX_FILE_BYTES)).toBe(true);
    expect(isHashable(HASH_MAX_FILE_BYTES + 1)).toBe(false);
    // A zero-byte file has nothing to compare and would group with every other
    // empty file the account holds.
    expect(isHashable(0)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* What gets asked about                                                       */
/* -------------------------------------------------------------------------- */

describe("preflightDuplicates - what it is willing to hash", () => {
  it("does not read a file past the per-file ceiling", async () => {
    // Declared size is what decides, so an oversized file is never read at all -
    // the ceiling exists to avoid the allocation, not to discard it afterwards.
    const huge = { id: "big", name: "capture.mkv", size: HASH_MAX_FILE_BYTES + 1, data: blob(8) };
    const out = await preflightDuplicates([huge]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.hits).toEqual([]);
    // Reported as not checked rather than as not a duplicate.
    expect(out.unchecked).toBe(1);
    expect(out.checked).toBe(0);
  });

  it("spends its batch budget in the order the files were dropped", async () => {
    repliesAllNew();
    // The DECLARED size is what the budget is spent from, so this costs nothing
    // to run: nine files each claiming the per-file maximum, of which the budget
    // affords exactly eight. The ninth is left unchecked rather than silently
    // declared new, and the eight are the first eight - a budget spent in some
    // other order would check the files at the bottom of a drop and report on
    // the ones nobody is looking at.
    const fits = HASH_MAX_BATCH_BYTES / HASH_MAX_FILE_BYTES;
    const files = Array.from({ length: fits + 1 }, (_, i) => ({
      id: `f${i}`,
      name: `f${i}`,
      size: HASH_MAX_FILE_BYTES,
      data: blob(16, i),
    }));

    const out = await preflightDuplicates(files);
    expect(askedFor()).toHaveLength(fits);
    expect(out.unchecked).toBe(1);

    // And they are the FIRST eight, by checksum.
    const expected = await Promise.all(files.slice(0, fits).map((f) => sha256Hex(f.data)));
    expect(askedFor().sort()).toEqual(expected.sort());
  });

  it("never asks about more checksums than the endpoint accepts", async () => {
    replies(answer({ results: [] }));
    const many = Array.from({ length: MAX_CHECKSUMS + 20 }, (_, i) => input(`f${i}`, 8, i));
    await preflightDuplicates(many);
    expect(askedFor().length).toBeLessThanOrEqual(MAX_CHECKSUMS);
  });

  it("sends each distinct checksum once, however many files carry it", async () => {
    replies(answer({ results: [] }));
    // The same screenshot dropped twice in one go.
    await preflightDuplicates([input("one", 64, 5), input("two", 64, 5)]);
    expect(askedFor()).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* What comes back                                                             */
/* -------------------------------------------------------------------------- */

describe("preflightDuplicates - reading the answer", () => {
  const file = input("shot", 512);

  async function respond(status: "duplicate" | "new" | "unknown", matches = 1) {
    const checksum = await sha256Hex(file.data);
    replies(
      answer({
        results: [
          {
            checksum,
            status,
            matches: Array.from({ length: matches }, (_, i) => ({
              id: `m${i}`,
              code: `code${i}`,
              filename: "older.png",
              ext: "png",
              mimeType: "image/png",
              size: 512,
              createdAt: "2026-01-01T00:00:00.000Z",
              folderId: null,
              folderName: null,
              url: `https://host.example.com/Tag/code${i}`,
              rawUrl: `https://host.example.com/Tag/code${i}/raw`,
              copyUrl: `https://host.example.com/Tag/code${i}`,
            })),
          },
        ],
      }),
    );
    return preflightDuplicates([file]);
  }

  it("reports a duplicate against the oldest existing copy", async () => {
    const out = await respond("duplicate", 2);
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]).toMatchObject({ id: "shot", copies: 2 });
    expect(out.hits[0].existing.code).toBe("code0");
    expect(out.checked).toBe(1);
  });

  it("treats `unknown` as nothing to say, not as a duplicate", async () => {
    const out = await respond("unknown");
    // The server sent a match list it could not vouch for; showing it would
    // claim a certainty the library cannot support.
    expect(out.hits).toEqual([]);
    expect(out.checked).toBe(0);
    expect(out.unchecked).toBe(1);
  });

  it("reports nothing for a file the server calls new", async () => {
    const out = await respond("new");
    expect(out.hits).toEqual([]);
    expect(out.checked).toBe(1);
    expect(out.unchecked).toBe(0);
  });

  it("ignores a `duplicate` verdict with no match attached", async () => {
    const checksum = await sha256Hex(file.data);
    replies(answer({ results: [{ checksum, status: "duplicate", matches: [] }] }));
    // A contradiction in the reply is not a reason to open a dialog with an
    // empty list in it.
    expect((await preflightDuplicates([file])).hits).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* It must never be able to stop an upload                                     */
/* -------------------------------------------------------------------------- */

describe("preflightDuplicates - failure is always silence", () => {
  const file = input("shot", 256);

  it("gives up on a refused request", async () => {
    replies({ message: "nope" }, false);
    await expect(preflightDuplicates([file])).resolves.toMatchObject({ hits: [] });
  });

  it("gives up when the network throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(preflightDuplicates([file])).resolves.toMatchObject({ hits: [] });
  });

  it("gives up on a body that is not the shape it expects", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    } as unknown as Response);
    await expect(preflightDuplicates([file])).resolves.toMatchObject({ hits: [] });
  });

  it("gives up when the browser has no WebCrypto at all", async () => {
    // The OUTCOME with no digest available: nothing asked, nothing claimed,
    // everything reported as unchecked. Reached by two routes in the code (the
    // `canHash` shortcut and the per-file catch), and this pins the outcome
    // rather than which of them got there.
    vi.stubGlobal("crypto", {});
    const out = await preflightDuplicates([file]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ hits: [], checked: 0, unchecked: 1 });
  });

  it("does nothing, and asks nothing, for an empty drop", async () => {
    await expect(preflightDuplicates([])).resolves.toMatchObject({ hits: [], unchecked: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("carries its own deadline so a stalled check cannot stall the upload", async () => {
    // A request that never settles must not leave the batch waiting on it. Only
    // setTimeout is faked, so the loop below can still yield to the real event
    // loop until the digest has finished and the request is genuinely in flight
    // - advancing a timer that has not been created yet would prove nothing.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );

      const pending = preflightDuplicates([file]);
      while (fetchMock.mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toMatchObject({ hits: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});
