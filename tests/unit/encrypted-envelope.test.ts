import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  aadFor,
  buildEnvelope,
  cipherTotalFor,
  decryptFrame,
  encryptFrame,
  frameCipherBytes,
  frameIndexAt,
  frameOffset,
  generateKeyBytes,
  importKey,
  isEncryptedUpload,
  ivFor,
  openEnvelope,
  parseEnvelopeHeader,
  plainBytesInFrame,
  CONTAINER_MAGIC,
  ENCRYPTED_EXT,
  ENCRYPTED_MIME,
  EnvelopeError,
  GCM_TAG_BYTES,
  HEADER_PROBE_BYTES,
  KEY_BYTES,
  MAX_FRAME_INDEX,
  METADATA_COUNTER,
  type EnvelopePlan,
} from "@/lib/crypto/envelope";
import { resolveUploadType, sniffMime } from "@/lib/media/sniff";
import { mediaKind, serveDecision } from "@/lib/media/mime";

/**
 * The container format, exercised against the same WebCrypto the browser uses.
 *
 * Everything here is a claim the feature would be worthless without: that the
 * ciphertext really is ciphertext, that no IV is used twice, that a tampered or
 * reordered or truncated file refuses to open, and that the SERVER's own type
 * machinery classifies a container as an opaque blob so it never hands one to
 * sharp, ffmpeg or an inline preview.
 */

const CHUNK = 1024; // small, so a handful of bytes still produces many frames

/** Assemble the whole container the way the upload source would emit it. */
async function seal(
  key: CryptoKey,
  plan: EnvelopePlan,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const out = new Uint8Array(plan.cipherTotalBytes);
  out.set(plan.header, 0);
  for (let index = 1; index <= plan.frameCount; index++) {
    const start = (index - 1) * plan.plainChunkBytes;
    const frame = await encryptFrame(
      key,
      plan,
      index,
      plaintext.subarray(start, start + plainBytesInFrame(plan, index)),
    );
    out.set(frame, frameOffset(plan, index));
  }
  return out;
}

/** Decrypt a whole container back to plaintext. */
async function unseal(key: CryptoKey, container: Uint8Array): Promise<Uint8Array> {
  const { params } = await openEnvelope(container, key);
  const out = new Uint8Array(params.plainTotalBytes);
  let at = 0;
  for (let index = 1; index <= params.frameCount; index++) {
    const start = frameOffset(params, index);
    const plain = await decryptFrame(
      key,
      params,
      index,
      container.subarray(start, start + frameCipherBytes(params, index)),
    );
    out.set(plain, at);
    at += plain.byteLength;
  }
  return out;
}

async function fixture(size: number, chunk = CHUNK) {
  const raw = generateKeyBytes();
  const key = await importKey(raw);
  const plaintext = new Uint8Array(randomBytes(size));
  const plan = await buildEnvelope({
    key,
    metadata: { name: "holiday.png", type: "image/png" },
    plainTotalBytes: size,
    plainChunkBytes: chunk,
  });
  return { key, plan, plaintext, container: await seal(key, plan, plaintext) };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("MLENC1 container", () => {
  it("recovers the plaintext byte for byte, and stores something else entirely", async () => {
    const { key, plaintext, container } = await fixture(9_000);

    expect(sha(container)).not.toBe(sha(plaintext));
    expect(container.byteLength).toBeGreaterThan(plaintext.byteLength);
    // Not "different bytes somewhere": the plaintext must not appear at all.
    expect(Buffer.from(container).includes(Buffer.from(plaintext.subarray(0, 64)))).toBe(false);

    const back = await unseal(key, container);
    expect(sha(back)).toBe(sha(plaintext));
  });

  it("handles an empty file and a file that is exactly one chunk", async () => {
    for (const size of [0, CHUNK]) {
      const { key, plaintext, container } = await fixture(size);
      expect(await unseal(key, container)).toEqual(plaintext);
    }
  });

  it("hides the filename and the MIME type from anything without the key", async () => {
    const { key, container } = await fixture(2_000);
    expect(Buffer.from(container).toString("latin1")).not.toContain("holiday.png");
    expect(Buffer.from(container).toString("latin1")).not.toContain("image/png");

    const { metadata } = await openEnvelope(container, key);
    expect(metadata).toEqual({ name: "holiday.png", type: "image/png" });
  });

  it("never repeats an IV within one file", async () => {
    const { plan } = await fixture(CHUNK * 40 + 7);
    const seen = new Set<string>();
    for (let counter = METADATA_COUNTER; counter <= plan.frameCount; counter++) {
      const iv = Buffer.from(ivFor(plan.noncePrefix, counter)).toString("hex");
      expect(seen.has(iv), `IV reused at counter ${counter}`).toBe(false);
      seen.add(iv);
    }
    expect(seen.size).toBe(plan.frameCount + 1);
  });

  it("gives two files different keys and different nonce prefixes", async () => {
    const a = await fixture(64);
    const b = await fixture(64);
    expect(Buffer.from(a.plan.noncePrefix).toString("hex")).not.toBe(
      Buffer.from(b.plan.noncePrefix).toString("hex"),
    );
    // The other file's key must not open this one.
    await expect(unseal(b.key, a.container)).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("refuses a file that would overflow the frame counter instead of wrapping it", async () => {
    const key = await importKey(generateKeyBytes());
    await expect(
      buildEnvelope({
        key,
        metadata: { name: "huge", type: "application/octet-stream" },
        // One frame past what a 32-bit counter can address.
        plainTotalBytes: (MAX_FRAME_INDEX + 1) * 1024,
        plainChunkBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("refuses a flipped bit", async () => {
    const { key, container } = await fixture(5_000);
    const tampered = container.slice();
    tampered[tampered.length - 40] ^= 0x01;
    await expect(unseal(key, tampered)).rejects.toMatchObject({ reason: "bad-key" });
  });

  it("refuses reordered frames", async () => {
    const { key, plan, container } = await fixture(CHUNK * 4);
    const swapped = container.slice();
    const one = container.slice(frameOffset(plan, 1), frameOffset(plan, 1) + frameCipherBytes(plan, 1));
    const two = container.slice(frameOffset(plan, 2), frameOffset(plan, 2) + frameCipherBytes(plan, 2));
    swapped.set(two, frameOffset(plan, 1));
    swapped.set(one, frameOffset(plan, 2));
    await expect(unseal(key, swapped)).rejects.toMatchObject({ reason: "bad-key" });
  });

  it("refuses a truncated file rather than returning a short one", async () => {
    const { key, plan, container } = await fixture(CHUNK * 4);
    // Drop the final frame. The header still says how many there should be.
    const cut = container.slice(0, frameOffset(plan, plan.frameCount));
    await expect(unseal(key, cut)).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("refuses a frame promoted to last (a silent truncation)", async () => {
    // The last-frame flag is in the AAD, so the frame before the end cannot be
    // passed off as the end even by an attacker who also rewrites the header.
    const { key, plan } = await fixture(CHUNK * 3);
    const middle = new Uint8Array(CHUNK).fill(7);
    const sealedAsMiddle = await encryptFrame(key, plan, 2, middle);
    const shorterPlan = { ...plan, frameCount: 2, plainTotalBytes: CHUNK * 2 };
    await expect(decryptFrame(key, shorterPlan, 2, sealedAsMiddle)).rejects.toMatchObject({
      reason: "bad-key",
    });
  });

  it("binds every frame to the whole fixed header", async () => {
    const { plan } = await fixture(CHUNK * 2);
    const aad = aadFor(plan.fixedHeader, 1, false);
    expect(aad.subarray(0, plan.fixedHeader.length)).toEqual(plan.fixedHeader);
    expect(aad.byteLength).toBe(plan.fixedHeader.length + 4 + 1);
  });

  it("computes the container size without touching the payload", async () => {
    const { plan, container } = await fixture(CHUNK * 5 + 3);
    expect(container.byteLength).toBe(plan.cipherTotalBytes);
    expect(plan.cipherTotalBytes).toBe(
      cipherTotalFor(plan.plainTotalBytes, plan.plainChunkBytes, plan.headerBytes),
    );
    // The overhead really is the header plus one tag per frame, nothing else.
    expect(plan.cipherTotalBytes - plan.plainTotalBytes).toBe(
      plan.headerBytes + plan.frameCount * GCM_TAG_BYTES,
    );
  });

  it("maps any container offset back to the frame that covers it", async () => {
    const { plan } = await fixture(CHUNK * 6 + 11);
    for (let index = 1; index <= plan.frameCount; index++) {
      const start = frameOffset(plan, index);
      const end = start + frameCipherBytes(plan, index) - 1;
      expect(frameIndexAt(plan, start)).toBe(index);
      expect(frameIndexAt(plan, end)).toBe(index);
    }
    expect(frameIndexAt(plan, 0)).toBe(0);
  });

  it("always fits its header inside one probe read", async () => {
    const key = await importKey(generateKeyBytes());
    const plan = await buildEnvelope({
      key,
      // Longer than uploads.filename allows, to prove the clamp holds.
      metadata: { name: "x".repeat(2_000) + ".png", type: "image/png" },
      plainTotalBytes: 10,
    });
    expect(plan.headerBytes).toBeLessThanOrEqual(HEADER_PROBE_BYTES);
  });

  it("rejects a key of the wrong size", async () => {
    await expect(importKey(new Uint8Array(KEY_BYTES - 1))).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("says plainly when the bytes are not a container", async () => {
    expect(() => parseEnvelopeHeader(new Uint8Array(64))).toThrowError(EnvelopeError);
    expect(() => parseEnvelopeHeader(new Uint8Array(4))).toThrowError(EnvelopeError);
  });
});

describe("what the server makes of a container", () => {
  it("does not mistake one for text, which would change how it is served", async () => {
    const { container } = await fixture(4_000);
    const head = Buffer.from(container.subarray(0, 4096));
    // The 0x00 at offset 6 is there for exactly this: the sniffer's last resort
    // is "does this decode as printable UTF-8", and random ciphertext would
    // usually fail that but not always.
    expect(head.subarray(0, CONTAINER_MAGIC.length).toString("latin1")).toBe(CONTAINER_MAGIC);
    expect(head[6]).toBe(0x00);
    expect(sniffMime(head)).toBeNull();
  });

  it("stores the opaque type, so no decoder is ever pointed at random bytes", async () => {
    const { container } = await fixture(4_000);
    const stored = resolveUploadType({
      clientMime: ENCRYPTED_MIME,
      filename: `abcdefghij.${ENCRYPTED_EXT}`,
      head: Buffer.from(container.subarray(0, 4096)),
    });
    expect(stored).toBe(ENCRYPTED_MIME);

    // "other" is what keeps sharp, ffmpeg, thumbnails, motion previews and
    // "download as" away from a container: every one of those gates on kind.
    expect(mediaKind(stored, ENCRYPTED_EXT)).toBe("other");

    // And the raw route hands it over as an attachment of unknown type, so it
    // can never be rendered as a document on our origin.
    expect(serveDecision(stored, ENCRYPTED_EXT)).toEqual({
      disposition: "attachment",
      contentType: "application/octet-stream",
    });
  });

  it("recognises an encrypted row only when both columns agree", () => {
    expect(isEncryptedUpload(ENCRYPTED_MIME, ENCRYPTED_EXT)).toBe(true);
    expect(isEncryptedUpload(`${ENCRYPTED_MIME}; charset=binary`, "MLENC")).toBe(true);
    // A plain file renamed to .mlenc is not a container.
    expect(isEncryptedUpload("image/png", ENCRYPTED_EXT)).toBe(false);
    // Nor is one whose extension was rewritten.
    expect(isEncryptedUpload(ENCRYPTED_MIME, "png")).toBe(false);
    expect(isEncryptedUpload(null, null)).toBe(false);
  });
});
