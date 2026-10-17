import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeKey,
  encodeKey,
  encryptedLink,
  keyFromFragment,
  urlLeaksKey,
  KEY_FRAGMENT_PARAM,
} from "@/lib/crypto/link";
import { generateKeyBytes, KEY_BYTES } from "@/lib/crypto/envelope";

/**
 * The key lives in the fragment. This file is what stops that from quietly
 * becoming untrue.
 *
 * Three layers, because one is not enough:
 *
 *  1. the builder puts the key after `#` and refuses a base URL that already
 *     carries a query or a fragment, so nothing can be merged into it;
 *  2. the reader accepts a fragment and NOTHING else, so a key moved to `?k=`
 *     stops working outright - the feature breaks loudly instead of leaking
 *     quietly into every access log, proxy and error report on the path;
 *  3. the encryption sources are scanned for query-shaped key parameters, which
 *     catches the change before anyone runs it.
 */

const PAGE = "https://h.example.com/ToqOse/quiet-harbour-42.mlenc";

describe("the key travels in the fragment", () => {
  it("puts the key after the hash and nowhere else", () => {
    const key = generateKeyBytes();
    const encoded = encodeKey(key);
    const link = encryptedLink(PAGE, encoded);

    const url = new URL(link);
    // What a browser actually sends is the path and the query. Neither may
    // contain the key.
    expect(url.search).toBe("");
    expect(url.pathname).not.toContain(encoded);
    expect(`${url.origin}${url.pathname}${url.search}`).toBe(PAGE);

    expect(url.hash).toBe(`#${KEY_FRAGMENT_PARAM}=${encoded}`);
    expect(urlLeaksKey(link, encoded)).toBe(false);
  });

  it("reads the key back out of the fragment", () => {
    const key = generateKeyBytes();
    const encoded = encodeKey(key);
    const link = encryptedLink(PAGE, encoded);
    const recovered = keyFromFragment(new URL(link).hash);
    expect(recovered).not.toBeNull();
    expect(Buffer.from(recovered!)).toEqual(Buffer.from(key));
  });

  /**
   * The regression this whole file exists for. If someone later "simplifies"
   * the link by moving the key into a query parameter, this is what fails: the
   * viewer's reader does not accept it, so the feature stops working rather
   * than starting to leak.
   */
  it("refuses a key supplied as a query parameter", () => {
    const encoded = encodeKey(generateKeyBytes());
    const queryLink = `${PAGE}?${KEY_FRAGMENT_PARAM}=${encoded}`;
    const url = new URL(queryLink);

    // This is exactly the call the viewer makes.
    expect(keyFromFragment(url.hash)).toBeNull();
    // And the shape is recognised as a leak.
    expect(urlLeaksKey(queryLink, encoded)).toBe(true);
    expect(url.search).toContain(encoded);
  });

  it("refuses a key smuggled into the path", () => {
    const encoded = encodeKey(generateKeyBytes());
    expect(urlLeaksKey(`https://h.example.com/ToqOse/${encoded}`, encoded)).toBe(true);
    expect(urlLeaksKey(`https://h.example.com/a?x=${encodeURIComponent(encoded)}`, encoded)).toBe(true);
  });

  it("will not build a link onto a base that already has a query or a fragment", () => {
    const encoded = encodeKey(generateKeyBytes());
    expect(() => encryptedLink(`${PAGE}?w=1`, encoded)).toThrow();
    expect(() => encryptedLink(`${PAGE}#already`, encoded)).toThrow();
  });

  it("treats a truncated or oversized key as no key at all", () => {
    expect(decodeKey(null)).toBeNull();
    expect(decodeKey("")).toBeNull();
    expect(decodeKey("not base64url!!")).toBeNull();
    expect(decodeKey(encodeKey(generateKeyBytes()).slice(0, 20))).toBeNull();
    expect(keyFromFragment("#k=")).toBeNull();
    expect(keyFromFragment("#")).toBeNull();
    expect(keyFromFragment(undefined)).toBeNull();
  });

  it("round-trips through base64url without padding or unsafe characters", () => {
    for (let i = 0; i < 50; i++) {
      const key = generateKeyBytes();
      const encoded = encodeKey(key);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(encoded).not.toContain("=");
      expect(Buffer.from(decodeKey(encoded)!)).toEqual(Buffer.from(key));
    }
    expect(encodeKey(new Uint8Array(KEY_BYTES)).length).toBe(43);
  });
});

/**
 * A source scan, because the two tests above only prove the CURRENT helpers are
 * right. This one fails on the commit that introduces a second way to carry the
 * key, before anybody has to notice at runtime.
 */
describe("no encryption code builds a query-borne key", () => {
  const FILES = [
    "lib/crypto/envelope.ts",
    "lib/crypto/link.ts",
    "components/upload/encrypted-source.ts",
    "components/upload/EncryptedUploader.tsx",
    "components/viewer/EncryptedViewer.tsx",
    "components/viewer/decrypt-transfer.ts",
  ];

  /** Query-parameter shapes that would put a key on the wire. */
  const FORBIDDEN: [RegExp, string][] = [
    [/[?&](k|key|secret|kek)=/, "a key-shaped query parameter in a URL literal"],
    [/searchParams\.(set|append)\(\s*["'`](k|key|secret|kek)["'`]/, "searchParams with a key name"],
    [/URLSearchParams\([^)]*encodedKey/, "the key handed to URLSearchParams"],
  ];

  for (const file of FILES) {
    it(`keeps the key out of query strings: ${file}`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      // Comments are prose about the rule, not code that breaks it.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      for (const [pattern, why] of FORBIDDEN) {
        expect(pattern.test(code), `${file}: ${why}`).toBe(false);
      }
    });
  }

  it("reads the key from the fragment in exactly one place", () => {
    const viewer = readFileSync(
      join(process.cwd(), "components/viewer/EncryptedViewer.tsx"),
      "utf8",
    );
    expect(viewer).toContain("keyFromFragment(window.location.hash)");
    // No other route into the key: not the search string, not the pathname.
    expect(viewer).not.toContain("location.search");
    expect(viewer).not.toContain("searchParams");
  });
});
