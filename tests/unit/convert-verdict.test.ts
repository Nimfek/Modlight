import { describe, it, expect, beforeEach } from "vitest";
import {
  readVerdict,
  rememberVerdict,
  resetVerdicts,
  verdictCount,
  verdictKey,
} from "@/lib/media/convert-verdict";

describe("convert verdict memo", () => {
  beforeEach(() => resetVerdicts());

  it("returns what was remembered, until it expires", () => {
    const key = verdictKey({ mediaId: 1, sourceTag: "abc", to: "mp3", privileged: false });
    rememberVerdict(key, { ok: false, status: 409, reason: "no-audio" }, 0);

    expect(readVerdict(key, 60_000)).toEqual({ ok: false, status: 409, reason: "no-audio" });
    // 10 minutes is the TTL; a second past it the answer is gone rather than stale.
    expect(readVerdict(key, 10 * 60 * 1000 + 1)).toBeNull();
  });

  it("keeps a privileged verdict apart from a public one", () => {
    const base = { mediaId: 1, sourceTag: "abc", to: "mp4" };
    const owner = verdictKey({ ...base, privileged: true });
    const stranger = verdictKey({ ...base, privileged: false });

    // The owner may run encoders and a stranger may not, so "no" for one is not
    // "no" for the other. Sharing a key would have the first visitor's 403
    // answer the owner's own menu.
    expect(owner).not.toBe(stranger);
  });

  it("forgets everything about a file whose bytes were replaced", () => {
    // Converting in place rewrites the bytes under the same row and code. The
    // checksum is in the key precisely so the old verdicts cannot answer for the
    // new file - an MKV that refused `webm` must not keep refusing it after
    // being replaced by an MP4.
    const before = verdictKey({ mediaId: 7, sourceTag: "old", to: "webm", privileged: true });
    const after = verdictKey({ mediaId: 7, sourceTag: "new", to: "webm", privileged: true });
    rememberVerdict(before, { ok: false, status: 409, reason: "video-codec" }, 0);

    expect(readVerdict(after, 1_000)).toBeNull();
  });

  it("stays bounded when flooded with keys inside one window", () => {
    // /convert is reachable with a public link and the key includes a
    // caller-chosen target, clip and offset. Sweeping only drops EXPIRED
    // entries, so without a hard cap a burst inside one TTL window would grow
    // this map without limit - the same leak the rate limiter had.
    const now = 1_000;
    for (let i = 0; i < 20_000; i++) {
      rememberVerdict(`flood ${i}`, { ok: true }, now);
    }
    expect(verdictCount()).toBeLessThanOrEqual(5_000);
    // FIFO: the newest survive, the oldest are the ones dropped.
    expect(readVerdict("flood 19999", now)).toEqual({ ok: true });
    expect(readVerdict("flood 0", now)).toBeNull();
  });
});
