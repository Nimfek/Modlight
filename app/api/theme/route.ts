import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user as users } from "@/lib/db/schema";
import { resolveApiCaller } from "@/lib/api-caller";
import { resolveTheme, type ThemeId } from "@/lib/themes";
import {
  DEFAULT_THEME,
  parseThemeBody,
  themeCatalog,
  THEME_BODY_MAX_BYTES,
} from "@/lib/theme-api";

/**
 * The account's skin, readable and writable by the desktop client.
 *
 * The owner asked for the sync to run BOTH ways ("niech w druga strone tez
 * dziala", docs/decyzje-modlight-app.md item 20): changing the theme in the app
 * changes it on the website, and changing it on the website is what the app
 * shows next time it asks.
 *
 * That works because `user.theme` is a single column that already drives
 * everything: the panel paints from it, and a shared link is painted in its
 * OWNER's skin (lib/media/serve.ts). There is no second copy to keep in step -
 * the `ml_skin` cookie is a first-paint hint, not a store, and app/layout.tsx
 * prefers this column over it precisely so a write that arrives without a
 * browser still shows up on the next page load.
 *
 * Authenticates with an API TOKEN first and a session second, in that order,
 * through `resolveApiCaller`. A token that is present and wrong is a refusal,
 * never a fall-through to whatever cookie the same request happened to carry,
 * and a token scoped away from writing can read this and not set it.
 */

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // A per-account answer must never be held by a shared cache.
      "cache-control": "private, no-store",
    },
  });
}

/** Same wording as /api/me, /api/folders and /api/shortlinks, so one client branch covers all. */
function unauthorized(): Response {
  return json({ message: "Token not specified or not found." }, 401);
}

/**
 * The wire shape, identical for GET and PUT so a client parses one thing.
 *
 * `theme` is the RESOLVED id, never the raw column: a row still holding the
 * retired `modern` answers `default`, which is the same skin under the name the
 * catalogue uses. Without that, a client doing the obvious read-then-write round
 * trip would send back a value its own picker could not match.
 *
 * `defaultTheme` rather than `default` because a client generating a model class
 * from this JSON would land on a reserved word in most of the languages a
 * desktop app is written in.
 */
function shape(theme: ThemeId) {
  return {
    theme,
    defaultTheme: DEFAULT_THEME,
    themes: themeCatalog(),
  };
}

export async function GET(req: Request): Promise<Response> {
  // Reading which skin the account wears.
  const auth = await resolveApiCaller(req, "read");
  if (!auth.ok) return json(auth.body, auth.status);
  const caller = auth.caller;

  const [row] = await db
    .select({ theme: users.theme })
    .from(users)
    .where(eq(users.id, caller.id))
    .limit(1);

  // No row means the account was deleted while the credential lived on. Same
  // answer as a bad credential: there is nobody to have preferences.
  if (!row) return unauthorized();

  return json(shape(resolveTheme(row.theme)));
}

export async function PUT(req: Request): Promise<Response> {
  // Changing it. It repaints the account's PUBLIC pages too (a shared link is
  // painted in its owner's skin), so this is not a private preference.
  const auth = await resolveApiCaller(req, "write");
  if (!auth.ok) return json(auth.body, auth.status);
  const caller = auth.caller;

  // No Content-Type check, unlike POST /api/shortlinks. There it is the CSRF
  // control, because a POST with a safelisted type is a "simple" request a
  // stranger's page can send at a logged-in visitor without a preflight. PUT is
  // never simple: the browser preflights it whatever the body says, and nothing
  // here answers a preflight. PUT /api/client-settings relies on the same thing.
  const body = await readCappedBody(req);
  if (!body.ok) {
    return json({ message: `Body must be at most ${THEME_BODY_MAX_BYTES} bytes.` }, 413);
  }

  const parsed = parseThemeBody(body.text);
  if (!parsed.ok) return json({ message: parsed.message }, parsed.status);

  // Ownership lives in the WHERE, not in a SELECT first: one statement cannot be
  // raced between its check and its write, and the row is read back rather than
  // assumed. An UPDATE that matched nothing is otherwise indistinguishable from
  // a successful save until the next page load puts the old skin back, which is
  // exactly how "the theme picker does nothing" presented in the panel.
  const [row] = await db
    .update(users)
    .set({ theme: parsed.theme })
    .where(eq(users.id, caller.id))
    .returning({ theme: users.theme });

  if (!row) return unauthorized();

  // Deliberately no cookie and no `revalidatePath`. The panel's Server Action
  // writes `ml_skin` because the browser making that request is the one about to
  // repaint; a desktop client has no cookie jar to write into and no router
  // cache to drop, and the pages that matter are rendered per request. The
  // database is what the next page load reads.
  return json(shape(resolveTheme(row.theme)));
}

type CappedBody = { ok: true; text: string } | { ok: false };

/**
 * Read the body, refusing anything oversized.
 *
 * Declared length first, because refusing by reading a header is free where
 * refusing afterwards means having buffered the thing in order to reject it. The
 * string is measured again once in hand: a chunked body declares no length at
 * all. Counted in UTF-16 units rather than bytes, which errs the safe way - a
 * string longer than N units is always more than N bytes of UTF-8.
 */
async function readCappedBody(req: Request): Promise<CappedBody> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > THEME_BODY_MAX_BYTES) return { ok: false };

  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: true, text: "" };
  }
  if (text.length > THEME_BODY_MAX_BYTES) return { ok: false };
  return { ok: true, text };
}
