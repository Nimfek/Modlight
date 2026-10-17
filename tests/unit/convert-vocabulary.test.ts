import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { noteKey, REFUSAL_KEYS } from "@/lib/media/convert-notes";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const messages = (locale: string) =>
  JSON.parse(read(`messages/${locale}/files.json`)).convert as {
    refused: Record<string, string>;
    note: Record<string, string>;
  };

/**
 * The refusal tokens the server can actually put on the wire, scraped from the
 * two places that emit them.
 *
 * Scraped rather than imported because both live in server-only modules that
 * would drag a database client into this test. The point of the test is that
 * the three lists - what the server says, what the client recognises, what the
 * translators wrote - cannot drift apart, and drift is exactly what a hand-kept
 * copy of a list does.
 */
function tokensEmittedByServer(): Set<string> {
  const av = read("lib/media/av-action.ts");
  const route = read("app/[userCode]/[mediaCode]/[action]/route.ts");

  const found = new Set<string>();

  // The two REASON_TEXT tables: every key is a token the endpoint can return.
  for (const source of [av, route]) {
    for (const block of source.matchAll(/REASON_TEXT: Record<string, string> = \{([\s\S]*?)\n\};/g)) {
      for (const key of block[1].matchAll(/^\s{2}"?([a-z-]+)"?:/gm)) found.add(key[1]);
    }
  }
  // Tokens written straight into a header, e.g. the limiter's busy/timeout.
  for (const source of [av, route]) {
    for (const m of source.matchAll(/"X-Convert-Refused":\s*"([a-z-]+)"/g)) found.add(m[1]);
  }
  return found;
}

describe("conversion refusal vocabulary", () => {
  it("gives every refusal the server can send a sentence in both languages", () => {
    const emitted = tokensEmittedByServer();
    // Sanity: if the scrape silently matched nothing, the rest of this test
    // would pass by saying nothing at all.
    expect(emitted.size).toBeGreaterThan(10);

    const en = messages("en").refused;
    const pl = messages("pl").refused;

    for (const token of emitted) {
      expect(REFUSAL_KEYS.has(token), `${token} is not in REFUSAL_KEYS`).toBe(true);
      expect(en[token], `no English sentence for ${token}`).toBeTruthy();
      expect(pl[token], `no Polish sentence for ${token}`).toBeTruthy();
    }
  });

  it("has no client-side reason the server cannot send", () => {
    const emitted = tokensEmittedByServer();
    for (const token of REFUSAL_KEYS) {
      expect(emitted.has(token), `${token} is claimed by the UI but never sent`).toBe(true);
    }
  });

  it("translates every note, and stays silent about ones it does not know", () => {
    const en = messages("en").note;
    const pl = messages("pl").note;
    for (const token of ["audio-dropped", "audio-reencoded", "clipped"]) {
      const key = noteKey(token);
      expect(key, `no key for ${token}`).toBeTruthy();
      expect(en[key!]).toBeTruthy();
      expect(pl[key!]).toBeTruthy();
    }

    // The regression this replaced: the old mapper ended in `default: "clipped"`,
    // so an unrecognised note told the user their download had been cut short -
    // a specific, confident, false claim. Silence is the correct failure.
    expect(noteKey("something-new")).toBeNull();
    expect(noteKey(null)).toBeNull();
    expect(noteKey("")).toBeNull();
  });
});
