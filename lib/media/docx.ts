/**
 * Turning a Word document into something a browser can show.
 *
 * This is a PREVIEW, and the word is meant literally. mammoth reads the document
 * body and produces semantic HTML - headings, lists, tables, images. It does not
 * read the page layout, so what comes out is the document's CONTENT reflowed for
 * a screen, not a picture of the pages. Nothing in the UI may suggest otherwise,
 * and nothing here produces a PDF.
 *
 * WHY THE OUTPUT GOES IN THE SANDBOX RATHER THAN THROUGH A SANITISER
 *
 * mammoth escapes the text it extracts, so the obvious injection is already
 * handled. That is not the same as the output being trustworthy:
 *
 *  - hyperlinks come from the document's relationship targets, which are
 *    arbitrary strings the author controls, `javascript:` included;
 *  - `convertImage` is ours, but the default is a data: URI of whatever bytes
 *    the document carries, and "an image" in an OOXML part is only an image
 *    because the document says so;
 *  - the safety of the rest rests on mammoth's escaping being complete, in every
 *    version we will ever upgrade to, for every element it learns to emit.
 *
 * Writing a sanitiser instead means owning a security-critical allowlist
 * forever, and being wrong about it silently. This app already has a mechanism
 * for showing untrusted markup, it is the one used for uploaded HTML and SVG,
 * and it has been reasoned through once: a separate route, a ticket proving the
 * upload's own gates were cleared, a response CSP with `sandbox` that drops the
 * document into an opaque origin, and an iframe with no allow-same-origin. The
 * document cannot reach a cookie, our DOM, or a server action, whatever mammoth
 * emits and whatever the document contains.
 *
 * Reusing it costs one entry in a table. Writing a second mechanism costs a
 * second thing to be wrong. And this shape goes one step further than uploaded
 * HTML does: it renders with `sandbox=""` and no `allow-scripts`, like SVG,
 * because a converted document has no legitimate reason to run anything.
 */

import "server-only";
import mammoth from "mammoth";
import { sharp } from "@/lib/media/sharp-runtime";
import { inspectZip, type ZipRefusal } from "@/lib/media/zip-guard";
import { MAX_DOCX_BYTES } from "@/lib/media/docx-support";

export { MAX_DOCX_BYTES, docxSupport, type DocxKind } from "@/lib/media/docx-support";

/**
 * What the archive may expand to. A .docx is mostly XML, which compresses about
 * 10:1, so a legitimate 10 MB document lands well inside this; a bomb does not.
 */
const ZIP_LIMITS = { totalBytes: 80 * 1024 * 1024, entryBytes: 40 * 1024 * 1024, entryCount: 4096 };

/**
 * Total bytes of inlined imagery.
 *
 * mammoth's default turns every embedded picture into a base64 data: URI with no
 * ceiling at all, so a document holding twelve 8 megapixel photographs becomes a
 * 40 MB HTML response - and base64 adds a third on top. Each image is re-encoded
 * below, and once this budget is spent the rest become placeholders rather than
 * being silently dropped.
 */
const IMAGE_BUDGET_BYTES = 3 * 1024 * 1024;

/** Longest edge an embedded image is scaled to. Wider than any reading column. */
const IMAGE_MAX_EDGE = 1280;

/** Ceiling on the generated markup, in case a document is mostly text. */
const MAX_HTML_BYTES = 4 * 1024 * 1024;

export type DocxRefusal = ZipRefusal | "too-large" | "legacy-doc" | "not-a-document";

export type DocxResult =
  | { ok: true; html: string; images: number; imagesDropped: number }
  | { ok: false; reason: DocxRefusal };

/**
 * Re-encode one embedded image to something bounded.
 *
 * Three things at once, and each matters: the dimensions are capped so a photo
 * straight off a camera does not travel at full size; WebP at q72 is a third of
 * the original for this kind of content; and sharp strips EXIF, so the location
 * and camera serial in a picture somebody pasted into a report do not leave with
 * the preview. The same privacy rule the upload path already applies.
 */
/**
 * Ceiling on a single embedded picture, in pixels.
 *
 * Without it this is the one sharp call in the whole conversion path with no
 * pixel budget: it would fall back to the library default of 268 Mpx, four
 * times looser than the loosest ceiling the rest of this work derives from the
 * container's 2 GiB. A .docx is a ZIP, so an attacker controls both the size of
 * each embedded image and how many there are, and the enclosing byte budget
 * (IMAGE_BUDGET_BYTES) counts ENCODED output, which says nothing about how much
 * memory decoding the input takes. 24 Mpx is far beyond any picture that
 * belongs in a document and stays well inside one queue slot.
 */
const IMAGE_MAX_PIXELS = 24_000_000;

async function shrinkImage(buf: Buffer): Promise<{ data: string; mime: string } | null> {
  try {
    const out = await sharp(buf, { failOn: "none", limitInputPixels: IMAGE_MAX_PIXELS })
      .rotate()
      .resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
    return { data: out.toString("base64"), mime: "image/webp" };
  } catch {
    // Not something libvips can read. A document can carry EMF/WMF vector
    // drawings, among other things; those become placeholders.
    return null;
  }
}

/**
 * Convert a .docx buffer to sandbox-ready HTML.
 *
 * Never throws for a bad document: every failure is a reason the caller can turn
 * into a sentence, because "this file is a zip bomb" and "this file is not a
 * Word document" deserve different messages and neither deserves a 500.
 */
export async function docxToHtml(buf: Buffer): Promise<DocxResult> {
  if (buf.length > MAX_DOCX_BYTES) return { ok: false, reason: "too-large" };

  // Before mammoth, always. See zip-guard.ts: once JSZip has the buffer there is
  // no timeout that can save the process, because it expands synchronously.
  const zip = inspectZip(buf, ZIP_LIMITS);
  if (!zip.ok) return { ok: false, reason: zip.reason };

  let spent = 0;
  let images = 0;
  let imagesDropped = 0;

  const convertImage = mammoth.images.imgElement(async (image) => {
    if (spent >= IMAGE_BUDGET_BYTES) {
      imagesDropped++;
      return { src: "", alt: "" };
    }
    const original = await image.read();
    const shrunk = await shrinkImage(Buffer.from(original));
    if (!shrunk) {
      imagesDropped++;
      return { src: "", alt: "" };
    }
    // base64 is four bytes for every three, and the budget is about what
    // travels over the wire, so it is charged on the encoded length.
    spent += shrunk.data.length;
    if (spent > IMAGE_BUDGET_BYTES) {
      imagesDropped++;
      return { src: "", alt: "" };
    }
    images++;
    return { src: `data:${shrunk.mime};base64,${shrunk.data}` };
  });

  let body: string;
  try {
    const result = await mammoth.convertToHtml({ buffer: buf }, { convertImage });
    body = result.value;
  } catch {
    return { ok: false, reason: "not-a-document" };
  }

  if (body.length > MAX_HTML_BYTES) return { ok: false, reason: "too-big" };

  return { ok: true, html: documentShell(body), images, imagesDropped };
}

/**
 * Wrap the fragment in a self-contained page.
 *
 * Self-contained because it has to be: the frame is an opaque origin under
 * `default-src 'none'`, so it can load no stylesheet, no font and no script of
 * ours, and the app's theme tokens do not reach it. A document is paper, so it
 * looks like paper - but it follows the reader's colour scheme, because a white
 * rectangle appearing inside a dark panel reads as a bug.
 *
 * Images with an empty `src` are the ones the budget refused; they are shown as
 * a labelled gap rather than as a broken-image icon.
 */
function documentShell(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Document preview</title>
<style>
  :root { color-scheme: light dark; --ink: #1c1c1e; --paper: #ffffff; --muted: #6b7280; --rule: #e5e7eb; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e8e8ea; --paper: #17171a; --muted: #9ca3af; --rule: #2e2e33; }
  }
  html { background: var(--paper); }
  body {
    margin: 0; padding: 2.5rem 1.5rem 4rem; background: var(--paper); color: var(--ink);
    font: 16px/1.7 ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  main { max-width: 46rem; margin: 0 auto; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2em 0 .6em; font-weight: 650; }
  h1 { font-size: 1.75rem; } h2 { font-size: 1.4rem; } h3 { font-size: 1.15rem; }
  p { margin: 0 0 1em; }
  a { color: inherit; text-underline-offset: 2px; }
  ul, ol { padding-left: 1.4em; margin: 0 0 1em; }
  li { margin: .25em 0; }
  img { max-width: 100%; height: auto; border-radius: 4px; display: block; margin: 1.25em 0; }
  img[src=""] {
    display: block; min-height: 4rem; border: 1px dashed var(--rule); border-radius: 4px;
    position: relative;
  }
  table { border-collapse: collapse; width: 100%; margin: 1.5em 0; font-size: .95em; }
  td, th { border: 1px solid var(--rule); padding: .45em .6em; text-align: left; vertical-align: top; }
  th { font-weight: 600; }
  blockquote { margin: 1.5em 0; padding-left: 1em; border-left: 3px solid var(--rule); color: var(--muted); }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 2em 0; }
  pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
  pre { overflow-x: auto; padding: .75em; border: 1px solid var(--rule); border-radius: 6px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
