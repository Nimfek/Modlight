import { describe, it, expect, vi } from "vitest";

/**
 * A killed probe must not be mistaken for a broken file.
 *
 * `probeAv` returning `null` feeds `av-action.ts`, which REMEMBERS it as
 * "unreadable" for ten minutes and then serves that verdict to every later
 * request for the same file - including real downloads, not just the `?check=1`
 * preflight. So the three things a bare `catch` used to flatten together had
 * very different consequences:
 *
 *   - ffprobe looked and this is not media we accept  -> a fact about the bytes
 *   - the caller hung up mid-probe                    -> a fact about a socket
 *   - the probe ran out of time                       -> a fact about the server
 *
 * Only the first is an answer about the file. The other two now propagate, so a
 * reload at the wrong moment - or one busy minute on the server - can no longer
 * make a perfectly good video report that it cannot be opened, for ten minutes,
 * to everyone holding a link to it.
 *
 * Written without `expect().rejects` and without a shared `beforeEach`: with
 * either of those, vitest attributed the rejected promise to the test as an
 * unhandled error and failed it even though the assertion itself passed (the
 * catch below was verified to receive exactly the right error while the test was
 * still being reported red). The plain try/catch says what happened, and nothing
 * else can fail around it.
 */

const runAvTool = vi.fn();

vi.mock("@/lib/media/ffmpeg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/media/ffmpeg")>();
  return { ...actual, runAvTool: (...args: unknown[]) => runAvTool(...args) };
});

const { probeAv } = await import("@/lib/media/av-probe");
const { AvAbortedError, AvTimeoutError, AvToolError } = await import("@/lib/media/ffmpeg");

const OPTS = { timeoutMs: 1000 };

/** What probeAv did when the tool rejected: passed it on, or answered null. */
async function outcome(err: Error): Promise<{ threw: unknown; value: unknown }> {
  runAvTool.mockImplementation(() => Promise.reject(err));
  try {
    return { threw: null, value: await probeAv("/tmp/x.mp4", OPTS) };
  } catch (caught) {
    return { threw: caught, value: undefined };
  }
}

describe("probeAv tells a killed probe from an unreadable file", () => {
  it("passes on the abort when the caller went away", async () => {
    const { threw } = await outcome(new AvAbortedError());
    expect(threw).toBeInstanceOf(AvAbortedError);
  });

  it("passes on the timeout when the probe ran out of time", async () => {
    const { threw } = await outcome(new AvTimeoutError(1000));
    expect(threw).toBeInstanceOf(AvTimeoutError);
  });

  it("still answers null when ffprobe looked and refused the content", async () => {
    // The tool ran and failed on the bytes. That IS an answer about the file,
    // and the conversion path is right to remember it.
    const { threw, value } = await outcome(new AvToolError("ffprobe", 1, "Invalid data found"));
    expect(threw).toBeNull();
    expect(value).toBeNull();
  });

  it("still answers null for a container we do not accept", async () => {
    runAvTool.mockImplementation(() =>
      Promise.resolve({
        stdout: JSON.stringify({ format: { format_name: "concat" }, streams: [] }),
        stderr: "",
      }),
    );
    expect(await probeAv("/tmp/x.txt", OPTS)).toBeNull();
  });

  it("still answers null for output that is not JSON at all", async () => {
    runAvTool.mockImplementation(() => Promise.resolve({ stdout: "not json", stderr: "" }));
    expect(await probeAv("/tmp/x.bin", OPTS)).toBeNull();
  });

  it("parses a real answer", async () => {
    runAvTool.mockImplementation(() =>
      Promise.resolve({
        stdout: JSON.stringify({
          format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.5" },
          streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
        }),
        stderr: "",
      }),
    );
    const probe = await probeAv("/tmp/x.mp4", OPTS);
    expect(probe?.container).toBe("mov");
    expect(probe?.duration).toBe(12.5);
    expect(probe?.video?.codec).toBe("h264");
  });
});
