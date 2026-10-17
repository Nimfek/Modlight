import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { shortLinks } from "@/lib/db/schema";
import { resolveApiCaller } from "@/lib/api-caller";
import { checkRateLimit } from "@/lib/password";
import { createShortLinkFor, shortLinkUrl } from "@/lib/shortlinks";
import type { CreateShortLinkInput, ShortLinkIssue } from "@/lib/shortlinks";

/**
 * The caller's short links, over HTTP.
 *
 * Exists for the desktop client: shortening the URL on the clipboard is a
 * hotkey, and a hotkey cannot invoke a Server Action. `app/actions/shortlinks`
 * still serves the panel, but both now call `createShortLinkFor` — the target
 * normalisation it goes through refuses `javascript:` and `data:` URLs, and that
 * guard existing in only one of the two paths is how a shortener turns into an
 * XSS vector on its own domain.
 *
 * Authenticates with an API TOKEN first and a session second, in that order, the
 * same way `/api/folders` and `/api/me` do. The token is what a desktop app
 * has; the session is a convenience so the same URL can be opened in a
 * logged-in browser while debugging. Either way the answer is scoped to one
 * account and never says anything about another.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // A per-account answer must never be held by a shared cache.
      "cache-control": "private, no-store",
      ...extra,
    },
  });
}

/**
 * How each refusal reaches the wire.
 *
 * An exhaustive `Record` on purpose: adding a member to `ShortLinkIssue` stops
 * compiling here until somebody decides what it means over HTTP, which is the
 * only thing keeping this table from quietly falling behind the union.
 *
 * `no-tag` is 422 rather than 409 deliberately. A client that sees 409 will read
 * it as "that code is taken, try another" and loop; nothing about a fresh code
 * helps an account that has no tag yet, and only its owner can fix it.
 */
const STATUS: Record<ShortLinkIssue, number> = {
  "invalid-url": 400,
  "invalid-code": 400,
  "code-too-long": 400,
  "code-taken": 409,
  "root-not-allowed": 403,
  "no-tag": 422,
  error: 500,
};

/**
 * Refusal body. `reason` is the contract; the wording is the client's business,
 * exactly as it is the panel's (which translates these into messages/*.json).
 * `message` is only ever added for a MALFORMED REQUEST, where the fault is in
 * the caller's code and a human reading a debug log is the actual audience.
 */
function refuse(reason: ShortLinkIssue, message?: string, status?: number): Response {
  return json({ ok: false, reason, ...(message ? { message } : {}) }, status ?? STATUS[reason]);
}

/**
 * Who is calling, and may their token do this? See lib/api-caller.ts.
 *
 * A token that is PRESENT decides the outcome on its own: falling through to the
 * session on a bad token would mean a stale desktop config silently acting as
 * whoever happens to be logged into the browser. A token whose scope does not
 * cover the verb is a 403 naming the scope that would - refusing to MINT a link
 * with a read-only credential while still listing the ones that exist is the
 * whole point of the split.
 */

export async function GET(req: Request): Promise<Response> {
  // Listing the caller's own short links.
  const auth = await resolveApiCaller(req, "read");
  if (!auth.ok) return json({ ok: false, ...auth.body }, auth.status);
  const ownerId = auth.caller.id;

  const rows = await db
    .select({
      id: shortLinks.id,
      code: shortLinks.code,
      target: shortLinks.target,
      clicks: shortLinks.clicks,
      // Asked as a boolean in SQL so the hash never leaves Postgres at all.
      // Selecting it and mapping it away works right up until someone spreads
      // the row into a response.
      hasPassword: sql<boolean>`${shortLinks.passwordHash} is not null`,
      lastUsedAt: shortLinks.lastUsedAt,
      expiresAt: shortLinks.expiresAt,
      createdAt: shortLinks.createdAt,
    })
    .from(shortLinks)
    .where(eq(shortLinks.ownerId, ownerId))
    .orderBy(desc(shortLinks.createdAt));

  return json({
    links: rows.map((l) => ({
      id: l.id,
      code: l.code,
      // Absolute, and built the same way the panel builds it, so a client never
      // has to know whether this deployment has a separate shortener domain.
      url: shortLinkUrl(l.code),
      target: l.target,
      clicks: l.clicks,
      hasPassword: l.hasPassword,
      lastUsedAt: l.lastUsedAt?.toISOString() ?? null,
      expiresAt: l.expiresAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
    })),
  });
}

/** Creations allowed per account, and the window they are counted over. */
const CREATE_LIMIT = 60;
const CREATE_WINDOW_MS = 60_000;

export async function POST(req: Request): Promise<Response> {
  // Minting a link that redirects under this deployment's name.
  const auth = await resolveApiCaller(req, "write");
  if (!auth.ok) return json({ ok: false, ...auth.body }, auth.status);
  const ownerId = auth.caller.id;

  // Priced per call, unlike the GET beside it: a short link may carry a
  // password, and hashing it runs scrypt — deliberately expensive, which is
  // exactly what makes an unbounded loop of them a way to spend the server's
  // CPU. Keyed on the account rather than the address, because a token is an
  // account and rotating IPs would otherwise sidestep it. The ceiling is far
  // above anything a person clicks and far below anything that hurts.
  const gate = checkRateLimit(`shortlink-create:${ownerId}`, CREATE_LIMIT, CREATE_WINDOW_MS);
  if (!gate.allowed) {
    return json(
      { ok: false, reason: "rate-limited", message: "Too many short links. Try again shortly." },
      429,
      { "retry-after": String(Math.ceil(gate.retryAfterMs / 1000)) },
    );
  }

  const parsed = await readCreateInput(req);
  if (!parsed.ok) return refuse(parsed.reason, parsed.message, parsed.status);

  // Caught here rather than in the shared core, which is left free to throw for
  // the panel's benefit. This endpoint's contract is that EVERY answer is a JSON
  // body carrying a `reason`, and a desktop client has no way to read the HTML
  // error page Next would otherwise return. `createShortLinkFor` does throw for
  // real — `uniqueCode` gives up after 50 collisions.
  let result;
  try {
    result = await createShortLinkFor(ownerId, parsed.input);
  } catch {
    return refuse("error");
  }
  if (!result.ok) return refuse(result.reason);

  // Deliberately no `revalidatePath`: the panel's action does that to drop the
  // browser's router cache after a mutation IT made, and there is no such cache
  // behind a desktop client. /dashboard/links renders per request anyway.
  return json(result, 201);
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

/**
 * scrypt is deliberately expensive, and its first step is linear in the length
 * of the password — an unbounded one is CPU the caller gets to spend for us.
 */
const PASSWORD_MAX = 1024;

/**
 * Ceiling on the request body.
 *
 * Every field this accepts is bounded (a 4 KiB target, a 256-char code, a 1 KiB
 * password), so 16 KiB is roomy — and without a ceiling `req.json()` buffers
 * whatever arrives into memory before there is anything to validate. Same
 * reasoning as the wallpaper upload in app/api/background/route.ts.
 */
const BODY_MAX = 16 * 1024;

type InputResult =
  | { ok: true; input: CreateShortLinkInput }
  | { ok: false; reason: ShortLinkIssue; message: string; status: number };

/** Absent = the field was not supplied. JSON `null` counts, so a client may send it explicitly. */
function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * Validate the request body into the shape the shared core takes.
 *
 * Every optional field is either absent or exactly its type — a wrong type is
 * refused rather than coerced or ignored. Ignoring a mistyped `customCode`, say,
 * would hand back a randomly generated link and let the client believe it had
 * claimed the name it asked for.
 *
 * Value-level rules (what counts as a URL, how long a code may be, what an
 * expiry of a trillion days means) are NOT repeated here: they belong to
 * `createShortLinkFor`, where the panel gets them too.
 */
async function readCreateInput(req: Request): Promise<InputResult> {
  const malformed = (message: string): InputResult =>
    ({ ok: false, reason: "error", message, status: 400 });
  const tooLarge = (): InputResult =>
    ({ ok: false, reason: "error", message: `Body must be at most ${BODY_MAX} bytes.`, status: 413 });

  // Content-Type is a CSRF control here, not decoration.
  //
  // This endpoint also accepts a plain session cookie, so a POST from any page
  // the victim visits would otherwise arrive authenticated. What stops it is the
  // browser: `application/json` is not one of the three CORS-safelisted request
  // types, so a cross-origin POST carrying it is preflighted, and nothing here
  // answers a preflight. Drop the check and the same request goes through as a
  // "simple" one with a `text/plain` body — `JSON.parse` would not notice — and
  // a stranger's page could mint links inside a logged-in visitor's namespace,
  // pointing wherever it liked. app/api/background/route.ts is protected by the
  // same accident of the CORS rules, via its image types.
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    return {
      ok: false,
      reason: "error",
      message: "Content-Type must be application/json.",
      status: 415,
    };
  }

  // Declared length first: refusing by reading a header is free, where refusing
  // after reading the body means having buffered the thing in order to reject it.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > BODY_MAX) return tooLarge();

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return malformed("Body could not be read.");
  }
  // A body may arrive chunked with no Content-Length, so the size is checked
  // again once it is in hand. Counted in UTF-16 units rather than bytes, which
  // errs the safe way: a string longer than N units is always more than N bytes
  // of UTF-8, so this only ever fires on a body that really is oversized.
  if (raw.length > BODY_MAX) return tooLarge();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return malformed("Body must be a JSON object.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return malformed("Body must be a JSON object.");
  }

  const b = body as Record<string, unknown>;

  if (typeof b.target !== "string") {
    return {
      ok: false,
      reason: "invalid-url",
      message: "`target` is required and must be a string.",
      status: 400,
    };
  }
  if (!absent(b.customCode) && typeof b.customCode !== "string") {
    return {
      ok: false,
      reason: "invalid-code",
      message: "`customCode` must be a string.",
      status: 400,
    };
  }
  if (!absent(b.expiresInDays) && typeof b.expiresInDays !== "number") {
    return malformed("`expiresInDays` must be a number of days.");
  }
  if (!absent(b.password) && typeof b.password !== "string") {
    return malformed("`password` must be a string.");
  }
  if (typeof b.password === "string" && b.password.length > PASSWORD_MAX) {
    return malformed(`\`password\` must be at most ${PASSWORD_MAX} characters.`);
  }
  if (!absent(b.useUserCode) && typeof b.useUserCode !== "boolean") {
    return malformed("`useUserCode` must be a boolean.");
  }

  return {
    ok: true,
    input: {
      target: b.target,
      customCode: typeof b.customCode === "string" ? b.customCode : undefined,
      expiresInDays: typeof b.expiresInDays === "number" ? b.expiresInDays : null,
      password: typeof b.password === "string" ? b.password : undefined,
      // Left undefined when absent so the core's own default (prefixed, the
      // unprivileged choice) applies rather than being decided out here.
      useUserCode: typeof b.useUserCode === "boolean" ? b.useUserCode : undefined,
    },
  };
}
