import { describe, it, expect } from "vitest";
import {
  isSharperType,
  isUselessMime,
  mimeFromExt,
  resolveUploadType,
  sniffMime,
} from "@/lib/media/sniff";

/** Build an ISO base media header: [size]["ftyp"][major][minor][compatible…]. */
function ftyp(major: string, compatible: string[] = []): Buffer {
  const size = 16 + compatible.length * 4;
  const buf = Buffer.alloc(Math.max(size, 32));
  buf.writeUInt32BE(size, 0);
  buf.write("ftyp", 4, "latin1");
  buf.write(major.padEnd(4, " "), 8, 4, "latin1");
  buf.writeUInt32BE(0, 12);
  compatible.forEach((brand, i) => buf.write(brand.padEnd(4, " "), 16 + i * 4, 4, "latin1"));
  return buf;
}

function bytes(...values: number[]): Buffer {
  return Buffer.from(values);
}

describe("sniffMime", () => {
  it("reads an AVIF image SEQUENCE, whose major brand is not 'avif'", () => {
    // The file the whole change exists for. Its major brand is `avis` and `avif`
    // appears only further down the compatible list, so a fixed 12-byte prefix
    // comparison - the obvious implementation - would have missed exactly this
    // one file while working for every other AVIF.
    const head = ftyp("avis", ["avis", "avif", "msf1", "iso8", "mif1", "miaf", "MA1B"]);
    expect(sniffMime(head)).toBe("image/avif");
  });

  it("reads a still AVIF, a HEIC and a QuickTime out of the same box", () => {
    expect(sniffMime(ftyp("avif", ["avif", "mif1"]))).toBe("image/avif");
    expect(sniffMime(ftyp("heic", ["mif1", "heic"]))).toBe("image/heic");
    expect(sniffMime(ftyp("qt", ["qt"]))).toBe("video/quicktime");
    expect(sniffMime(ftyp("M4A", ["M4A", "isom"]))).toBe("audio/mp4");
  });

  it("falls back to the container when no brand is specific", () => {
    expect(sniffMime(ftyp("isom", ["isom", "avc1", "mp42"]))).toBe("video/mp4");
  });

  it("prefers a specific compatible brand over a generic major one", () => {
    // `mif1` says "some HEIF-family image"; `avif` in the list says which.
    expect(sniffMime(ftyp("mif1", ["mif1", "avif"]))).toBe("image/avif");
  });

  it("recognises the common signatures", () => {
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffMime(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMime(bytes(0x50, 0x4b, 0x03, 0x04))).toBe("application/zip");
    expect(sniffMime(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("video/x-matroska");
    expect(sniffMime(Buffer.from("OggS"))).toBe("application/ogg");
  });

  it("splits RIFF by its form tag", () => {
    const riff = (form: string) => {
      const b = Buffer.alloc(16);
      b.write("RIFF", 0, "latin1");
      b.write(form, 8, 4, "latin1");
      return b;
    };
    expect(sniffMime(riff("WEBP"))).toBe("image/webp");
    expect(sniffMime(riff("WAVE"))).toBe("audio/wav");
    expect(sniffMime(riff("AVI "))).toBe("video/x-msvideo");
  });

  it("recognises plain text as a last resort", () => {
    // Production has a row exactly like this: a log file with no extension,
    // stored as octet-stream, downloadable but never viewable.
    const log = Buffer.from("[2025-09-28 15:52:42.808] [client] [error] invalid idx 0\n");
    expect(sniffMime(log)).toBe("text/plain");
    expect(sniffMime(Buffer.from("zażółć gęślą jaźń"))).toBe("text/plain");
  });

  it("does not mistake binary for text", () => {
    expect(sniffMime(bytes(0x29, 0xde, 0x6c, 0xc0, 0xba, 0xa4, 0x53, 0x2b))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });

  it("survives a multi-byte character cut in half by the read window", () => {
    // The header is a fixed-size slice, so the last character is often truncated.
    const full = Buffer.from("ąęśćżźół");
    expect(sniffMime(full.subarray(0, full.length - 1))).toBe("text/plain");
  });
});

describe("resolveUploadType", () => {
  it("rescues the reported file: octet-stream from ShareX, .avif on disk", () => {
    expect(
      resolveUploadType({
        clientMime: "application/octet-stream",
        filename: "convert.avif",
        head: ftyp("avis", ["avis", "avif", "msf1"]),
      }),
    ).toBe("image/avif");
  });

  it("works from the name alone when the bytes are unavailable", () => {
    expect(
      resolveUploadType({ clientMime: "application/octet-stream", filename: "a.avif" }),
    ).toBe("image/avif");
  });

  it("believes the bytes over both the name and the client", () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(
      resolveUploadType({ clientMime: "image/jpeg", filename: "screenshot.jpg", head: png }),
    ).toBe("image/png");
  });

  it("lets the extension name the payload inside a container", () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04);
    expect(resolveUploadType({ filename: "report.docx", head: zip })).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(resolveUploadType({ filename: "app.jar", head: zip })).toBe(
      "application/java-archive",
    );
    // ...but a bare zip stays a zip.
    expect(resolveUploadType({ filename: "backup.zip", head: zip })).toBe("application/zip");
    expect(resolveUploadType({ filename: "nameless", head: zip })).toBe("application/zip");
  });

  it("refines text and ISO containers the same way", () => {
    const text = Buffer.from('{"Version":"16.1.0"}');
    expect(resolveUploadType({ filename: "modlight.sxcu", head: text })).toBe("application/json");
    expect(resolveUploadType({ filename: "notes.md", head: text })).toBe("text/markdown");
    expect(
      resolveUploadType({ filename: "song.m4a", head: ftyp("isom", ["isom", "mp42"]) }),
    ).toBe("audio/mp4");
  });

  it("never lets the extension argue with a specific signature", () => {
    // A .mp4 that is really an AVIF sequence is an AVIF sequence.
    expect(
      resolveUploadType({ filename: "clip.mp4", head: ftyp("avis", ["avis", "avif"]) }),
    ).toBe("image/avif");
  });

  it("uses the client's type only when it is specific and nothing else knows", () => {
    const garbage = bytes(0x29, 0xde, 0x6c, 0xc0, 0xba, 0xa4, 0x53, 0x2b);
    expect(
      resolveUploadType({ clientMime: "application/x-thing", filename: "a.qqq", head: garbage }),
    ).toBe("application/x-thing");
    expect(
      resolveUploadType({ clientMime: "application/octet-stream", filename: "a.qqq", head: garbage }),
    ).toBe("application/octet-stream");
  });

  it("keeps octet-stream when that is the honest answer", () => {
    // A Granny2 mesh has no registered type. Production holds one, and inventing
    // something for it would be worse than saying so.
    const granny = bytes(0x29, 0xde, 0x6c, 0xc0, 0xba, 0xa4, 0x53, 0x2b);
    expect(resolveUploadType({ filename: "mesh.gr2", head: granny })).toBe(
      "application/octet-stream",
    );
  });
});

describe("mimeFromExt", () => {
  it("says nothing rather than guessing", () => {
    expect(mimeFromExt("qqq")).toBeNull();
    expect(mimeFromExt("")).toBeNull();
    expect(mimeFromExt(null)).toBeNull();
  });

  it("normalises the key", () => {
    expect(mimeFromExt("PNG")).toBe("image/png");
    expect(mimeFromExt(".Mp4")).toBe("video/mp4");
  });
});

describe("isUselessMime / isSharperType", () => {
  it("knows which types carry no information", () => {
    expect(isUselessMime("application/octet-stream")).toBe(true);
    expect(isUselessMime("binary/octet-stream")).toBe(true);
    expect(isUselessMime("")).toBe(true);
    expect(isUselessMime("image/png")).toBe(false);
  });

  it("only ever sharpens, so a repair pass cannot damage a good row", () => {
    expect(isSharperType("application/octet-stream", "image/avif")).toBe(true);
    expect(isSharperType("image/avif", "application/octet-stream")).toBe(false);
    expect(isSharperType("image/png", "image/jpeg")).toBe(false); // reported, not written
    expect(isSharperType("image/png", "image/png")).toBe(false);
  });
});
