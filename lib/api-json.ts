/**
 * Reading a JSON request body on the desktop client's HTTP surface.
 *
 * Three things every write endpoint has to get right, and which are easy to get
 * wrong once per endpoint:
 *
 *  1. **Content-Type is a CSRF control, not decoration.** These routes also
 *     accept a plain session cookie, so a POST from any page the victim visits
 *     arrives authenticated. What stops it is the browser: `application/json` is
 *     not one of the three CORS-safelisted request content types, so a
 *     cross-origin POST carrying it is preflighted and nothing here answers a
 *     preflight. Drop the check and the same request goes through as a "simple"
 *     one with a `text/plain` body, which `JSON.parse` would not notice.
 *     (PATCH and DELETE are already preflighted on account of the METHOD; the
 *     check is uniform anyway, because "which methods are simple" is not a thing
 *     anyone should have to recall while editing a handler.)
 *  2. **A ceiling before the read.** `req.json()` buffers whatever arrives into
 *     memory before there is anything to validate.
 *  3. **An object, not an array or a bare scalar** — `typeof null === "object"`
 *     has cost enough people enough hours.
 *
 * Same reasoning as `readCreateInput` in app/api/shortlinks/route.ts, which
 * predates this helper.
 */

export type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; message: string };

/**
 * Default ceiling. Generous for a body whose fields are an id, a name bounded at
 * 120 characters and a couple of booleans; small enough that a flood costs the
 * sender more than us.
 */
export const JSON_BODY_MAX = 16 * 1024;

export async function readJsonObject(
  req: Request,
  maxBytes: number = JSON_BODY_MAX,
): Promise<JsonBodyResult> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    return { ok: false, status: 415, message: "Content-Type must be application/json." };
  }

  // Declared length first: refusing by reading a header is free, where refusing
  // after reading the body means having buffered the thing in order to reject it.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, message: `Body must be at most ${maxBytes} bytes.` };
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, status: 400, message: "Body could not be read." };
  }
  // A body may arrive chunked with no Content-Length, so the size is checked
  // again once it is in hand. Counted in UTF-16 units rather than bytes, which
  // errs the safe way: a string longer than N units is always more than N bytes
  // of UTF-8, so this only ever fires on a body that really is oversized.
  if (raw.length > maxBytes) {
    return { ok: false, status: 413, message: `Body must be at most ${maxBytes} bytes.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, message: "Body must be a JSON object." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, message: "Body must be a JSON object." };
  }

  return { ok: true, body: parsed as Record<string, unknown> };
}

/**
 * Was a key SUPPLIED, as opposed to absent?
 *
 * JSON `null` is a value here, not a gap: `{"parentId": null}` means "move to
 * the root" and `{}` means "leave the parent alone". Collapsing the two would
 * make a rename silently un-nest the folder.
 */
export function supplied(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}
