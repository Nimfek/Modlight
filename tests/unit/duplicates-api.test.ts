import { describe, it, expect, vi, beforeEach } from "vitest";
import { tokenOk, tokenUnknown } from "../helpers/token-auth";

/**
 * The duplicate surface a desktop client sees, driven through the real route.
 *
 * Only three things are stubbed, and they are exactly the three that need a
 * database: the scan and the two writes to the dismissed set. Everything the
 * route itself decides - who may call it, which verb a body is asking for, what
 * a malformed digest is worth, and whether the reminder is due - runs for real,
 * because a test that mocked those would only prove the route can call a mock.
 */

const authenticateApiToken = vi.fn();
const getSession = vi.fn();
const scanDuplicates = vi.fn();
const dismissChecksums = vi.fn();
const restoreChecksums = vi.fn();
const recordAudit = vi.fn(async () => {});

vi.mock("@/lib/api-token", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-token")>("@/lib/api-token");
  return { ...actual, authenticateApiToken };
});
vi.mock("@/lib/auth-helpers", () => ({ getSession }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/data/duplicates", async () => {
  // The thresholds and `reminderDue` are the real ones: they are the answer the
  // client is told to trust instead of carrying its own copy of "10 files or
  // 1 GB", so a stub would be testing the wrong constant.
  const actual =
    await vi.importActual<typeof import("@/lib/data/duplicates")>("@/lib/data/duplicates");
  return { ...actual, scanDuplicates, dismissChecksums, restoreChecksums };
});

const route = await import("@/app/api/duplicates/route");
const { REMINDER_MIN_BYTES, REMINDER_MIN_REDUNDANT } = await import("@/lib/data/duplicates");

const ENDPOINT = "https://host.example.com/api/duplicates";
const DIGEST = "a".repeat(64);
const OTHER = "b".repeat(64);

function get(headers: Record<string, string> = { "x-api-key": "good" }) {
  return new Request(ENDPOINT, { headers });
}

function post(body: unknown, type = "application/json") {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": type, "x-api-key": "good" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function read(res: Response) {
  return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
}

function scan(over: Record<string, unknown> = {}) {
  return {
    groups: [],
    totalGroups: 0,
    totalFiles: 0,
    reclaimable: 0,
    dismissedGroups: 0,
    active: { groups: 0, redundant: 0, reclaimable: 0 },
    truncated: false,
    unchecksummed: 8623,
    scannedAt: "2026-08-19T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  authenticateApiToken.mockReset();
  getSession.mockReset();
  scanDuplicates.mockReset();
  dismissChecksums.mockReset();
  restoreChecksums.mockReset();
  recordAudit.mockClear();
  authenticateApiToken.mockResolvedValue(tokenOk({ id: "u1", banned: false, role: "user" }));
  dismissChecksums.mockResolvedValue(1);
  restoreChecksums.mockResolvedValue(1);
});

describe("GET /api/duplicates", () => {
  it("refuses a caller whose token is not known", async () => {
    authenticateApiToken.mockResolvedValue(tokenUnknown());
    const { status } = await read(await route.GET(get()));
    expect(status).toBe(401);
    // And it never went near the library.
    expect(scanDuplicates).not.toHaveBeenCalled();
  });

  it("scans only the caller's own account", async () => {
    scanDuplicates.mockResolvedValue(scan());
    await route.GET(get());
    expect(scanDuplicates).toHaveBeenCalledWith("u1");
  });

  it("carries the count of files it could not compare", async () => {
    scanDuplicates.mockResolvedValue(scan());
    const { body } = await read(await route.GET(get()));
    // Without this a migrated library reads "no duplicates found" as a statement
    // about files the scan never looked at.
    expect(body.unchecksummed).toBe(8623);
  });

  it("says whether the reminder is due, and on what thresholds", async () => {
    scanDuplicates.mockResolvedValue(
      scan({ active: { groups: 3, redundant: REMINDER_MIN_REDUNDANT + 1, reclaimable: 0 } }),
    );
    const { body } = await read(await route.GET(get()));
    expect(body.due).toBe(true);
    // Quoted from the server so a client cannot go on nagging at old figures.
    expect(body.thresholds).toEqual({
      redundant: REMINDER_MIN_REDUNDANT,
      bytes: REMINDER_MIN_BYTES,
    });
  });

  it("is not due while the account sits on the threshold", async () => {
    scanDuplicates.mockResolvedValue(
      scan({ active: { groups: 3, redundant: REMINDER_MIN_REDUNDANT, reclaimable: 0 } }),
    );
    const { body } = await read(await route.GET(get()));
    // "more than", not "at least" - the same reading the panel's banner uses.
    expect(body.due).toBe(false);
  });

  it("counts the dismissed sets out of the totals it judges on", async () => {
    scanDuplicates.mockResolvedValue(
      scan({
        totalGroups: 40,
        reclaimable: REMINDER_MIN_BYTES * 4,
        dismissedGroups: 40,
        active: { groups: 0, redundant: 0, reclaimable: 0 },
      }),
    );
    const { body } = await read(await route.GET(get()));
    // A library entirely made of sets the owner has kept is not due, however big.
    expect(body.due).toBe(false);
  });
});

describe("POST /api/duplicates", () => {
  it("insists on exactly one verb", async () => {
    const neither = await read(await route.POST(post({})));
    expect(neither.status).toBe(400);
    expect(neither.body.reason).toBe("one-verb");

    // Both at once has no obviously right ordering, so it is refused rather than
    // resolved by whichever branch happens to run second.
    const both = await read(
      await route.POST(post({ keep: [{ checksum: DIGEST }], countAgain: [DIGEST] })),
    );
    expect(both.status).toBe(400);
    expect(both.body.reason).toBe("one-verb");
    expect(dismissChecksums).not.toHaveBeenCalled();
    expect(restoreChecksums).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    // Content-Type is the CSRF control here: these routes also accept a session
    // cookie, and application/json is what makes a cross-origin POST preflight.
    const { status } = await read(await route.POST(post({ countAgain: [DIGEST] }, "text/plain")));
    expect(status).toBe(415);
  });

  it("refuses anything that is not a sha256", async () => {
    const { status, body } = await read(await route.POST(post({ countAgain: ["not-a-digest"] })));
    expect(status).toBe(400);
    expect(body.reason).toBe("malformed");
    // `duplicate_dismissals.checksum` is a varchar, so Postgres would have stored
    // this happily and the row would sit there matching nothing for ever.
    expect(restoreChecksums).not.toHaveBeenCalled();
  });

  it("keeps a set, normalising the digest and carrying its size", async () => {
    const { status, body } = await read(
      await route.POST(post({ keep: [{ checksum: DIGEST.toUpperCase(), copies: 4, bytes: 900 }] })),
    );

    expect(status).toBe(200);
    expect(body.kept).toBe(1);
    expect(dismissChecksums).toHaveBeenCalledWith("u1", [
      { checksum: DIGEST, copies: 4, bytes: 900 },
    ]);
  });

  it("matches the copies note back by digest, not by position", async () => {
    // `parseChecksums` lower-cases and de-duplicates, so an input whose order it
    // changes must not hand set A's counts to set B.
    await route.POST(
      post({
        keep: [
          { checksum: OTHER, copies: 2, bytes: 20 },
          { checksum: DIGEST, copies: 9, bytes: 90 },
        ],
      }),
    );

    const [, entries] = dismissChecksums.mock.calls[0] as unknown as
      [string, { checksum: string; copies: number }[]];
    expect(entries.find((e) => e.checksum === OTHER)?.copies).toBe(2);
    expect(entries.find((e) => e.checksum === DIGEST)?.copies).toBe(9);
  });

  it("treats a missing or nonsensical count as no count at all", async () => {
    await route.POST(post({ keep: [{ checksum: DIGEST, copies: -3 }] }));
    expect(dismissChecksums).toHaveBeenCalledWith("u1", [
      { checksum: DIGEST, copies: 0, bytes: 0 },
    ]);
  });

  it("counts a set again, and scopes that to the caller", async () => {
    const { status, body } = await read(await route.POST(post({ countAgain: [DIGEST] })));

    expect(status).toBe(200);
    expect(body.restored).toBe(1);
    // The account id is the first argument: a checksum is a global fact about
    // bytes, so a delete matching on the digest alone would let one account clear
    // another's decision.
    expect(restoreChecksums).toHaveBeenCalledWith("u1", [DIGEST]);
  });

  it("writes both decisions to the audit log", async () => {
    await route.POST(post({ keep: [{ checksum: DIGEST }] }));
    await route.POST(post({ countAgain: [DIGEST] }));

    const actions = (recordAudit.mock.calls as unknown as [string, string, unknown][]).map(
      ([, action]) => action,
    );
    expect(actions).toEqual([
      "uploads.duplicates_kept",
      "uploads.duplicates_counted_again",
    ]);
  });

  it("refuses an unknown token before reading a body", async () => {
    authenticateApiToken.mockResolvedValue(tokenUnknown());
    const { status } = await read(await route.POST(post({ countAgain: [DIGEST] })));
    expect(status).toBe(401);
    expect(restoreChecksums).not.toHaveBeenCalled();
  });
});
