/**
 * Make an AVIF image SEQUENCE readable, in memory only.
 *
 * libvips picks its loader from the MAJOR brand of the `ftyp` box and nothing
 * else, so a file whose major brand is `avis` is refused outright - even though
 * `avif` is right there in its compatible-brands list and libheif can decode the
 * cover image perfectly well. Four bytes in a COPY of the buffer work around the
 * reader; the stored file is never touched, because there is nothing wrong with
 * it.
 *
 * Pure and dependency-free so every sharp caller can share it: the conversion
 * path had this workaround and the thumbnail and metadata paths did not, which
 * is why one production file (alicja/tibax8.avif) had no preview, no dimensions
 * and no blurhash while converting perfectly well.
 */
export function withStillAvifBrand(buf: Buffer): Buffer | null {
  if (buf.length < 16) return null;
  if (buf.toString("latin1", 4, 8) !== "ftyp") return null;
  if (buf.toString("latin1", 8, 12) !== "avis") return null;
  const copy = Buffer.from(buf);
  copy.write("avif", 8, 4, "latin1");
  return copy;
}
