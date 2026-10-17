import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { docxToHtml } from "@/lib/media/docx";
import { docxSupport } from "@/lib/media/docx-support";

/**
 * Build a real .docx in memory.
 *
 * A .docx is a ZIP holding a handful of OOXML parts. Only three are needed for
 * mammoth to read a document body, so this writes those rather than pulling in a
 * document-authoring dependency to test a converter.
 */
function buildDocx(bodyXml: string, extra: { name: string; body: Buffer }[] = []): Buffer {
  const members = [
    {
      name: "[Content_Types].xml",
      body: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      body: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
    },
    {
      name: "word/document.xml",
      body: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
      ),
    },
    ...extra,
  ];

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const m of members) {
    const data = deflateRawSync(m.body);
    const name = Buffer.from(m.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(m.body), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(m.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(m.body), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(m.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, eocd]);
}

let table: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!table) {
    table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const para = (text: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;

describe("which files get a document preview", () => {
  it("recognises a .docx by type or by name", () => {
    const docxMime =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(docxSupport(docxMime, "docx")).toBe("docx");
    // The common case on this deployment: ShareX and old imports store
    // octet-stream, so the name is the only evidence there is.
    expect(docxSupport("application/octet-stream", "docx")).toBe("docx");
    expect(docxSupport(docxMime, null)).toBe("docx");
  });

  it("names the legacy .doc case instead of lumping it in with 'no'", () => {
    // mammoth cannot read a byte of OLE2, so the UI has to say the format is
    // unsupported rather than render an empty page.
    expect(docxSupport("application/msword", "doc")).toBe("legacy-doc");
    expect(docxSupport("application/octet-stream", "doc")).toBe("legacy-doc");
  });

  it("claims nothing else", () => {
    expect(docxSupport("application/pdf", "pdf")).toBeNull();
    expect(docxSupport("image/png", "png")).toBeNull();
    expect(docxSupport("application/vnd.ms-excel", "xls")).toBeNull();
  });
});

describe("converting a document", () => {
  it("turns a real document into structured HTML", async () => {
    const docx = buildDocx(para("A Title", "Heading1") + para("Some body text."));
    const result = await docxToHtml(docx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain("Some body text.");
    expect(result.html).toContain("<h1>A Title</h1>");
  });

  it("produces a self-contained page, because the sandbox can load nothing", async () => {
    // The frame is an opaque origin under `default-src 'none'`: no stylesheet,
    // no font and no script of ours can reach it.
    const result = await docxToHtml(buildDocx(para("hello")));
    if (!result.ok) throw new Error(result.reason);
    expect(result.html).toMatch(/^<!doctype html>/i);
    expect(result.html).toContain("<style>");
    expect(result.html).not.toMatch(/<link[^>]+href/i);
    expect(result.html).not.toMatch(/<script/i);
  });

  it("follows the reader's colour scheme rather than flashing white", async () => {
    const result = await docxToHtml(buildDocx(para("hello")));
    if (!result.ok) throw new Error(result.reason);
    expect(result.html).toContain("prefers-color-scheme: dark");
  });

  it("escapes text that would otherwise become markup", async () => {
    const result = await docxToHtml(buildDocx(para("&lt;script&gt;alert(1)&lt;/script&gt;")));
    if (!result.ok) throw new Error(result.reason);
    // mammoth escapes, and the sandbox is what makes it not matter if it ever
    // stops - but the escaping should still be true today.
    expect(result.html).not.toContain("<script>alert(1)");
    expect(result.html).toContain("&lt;script&gt;");
  });

  // 20s, because the setup genuinely allocates and deflates 120 MB. On an idle
  // machine that lands around 4s — under the default 5s budget by a margin so
  // thin that any parallel load pushes it over, and a test that fails for being
  // on a busy laptop teaches everyone to ignore it.
  it("refuses a zip bomb before mammoth is handed the buffer", { timeout: 20_000 }, async () => {
    // Once JSZip has it, expansion is synchronous and no timeout can help.
    const bomb = buildDocx(para("x"), [
      { name: "word/media/huge.bin", body: Buffer.alloc(120 * 1024 * 1024, 0) },
    ]);
    const result = await docxToHtml(bomb);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too-big");
  });

  it("refuses a file that is not a document at all", async () => {
    expect(await docxToHtml(Buffer.from("this is not a docx"))).toEqual({
      ok: false,
      reason: "not-a-zip",
    });
  });

  it("refuses an oversized document by size alone", async () => {
    const huge = Buffer.alloc(11 * 1024 * 1024, 0x50);
    expect(await docxToHtml(huge)).toEqual({ ok: false, reason: "too-large" });
  });
});
