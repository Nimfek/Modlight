// NOT reachable from server.ts, and must stay that way: this imports
// @/lib/auth-helpers, which carries `import "server-only"` — a specifier that
// resolves only inside Next's bundler and vitest's alias, never in the plain
// esbuild bundle the custom server is built as. Pulling this into server.ts
// would fail at link time, before server.listen(). Route handlers and pages are
// exactly where it belongs. (scripts/check-server-bundle.mjs is the backstop.)
import { eq } from "drizzle-orm";
import {
  authenticateApiToken,
  bearerFromRequest,
  tokenRefusal,
  type TokenAuth,
  type TokenCapability,
  type TokenScope,
  type UserRow,
} from "@/lib/api-token";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { user as users } from "@/lib/db/schema";

/**
 * Who is calling a token-or-session API route.
 *
 * The order and, more importantly, the EXCLUSIVITY are the whole point. A
 * credential that is present and wrong is a refusal, never a fall-through to
 * whatever cookie the same request happened to carry: written as
 * "try the token, then try the session", a desktop client holding a revoked
 * token would keep working in any context where a browser session existed, and
 * would stop working the moment it did not — which is the confusing half of the
 * bug, and the dangerous half is that a request authenticated by a stale
 * credential answers with somebody's real data.
 *
 * So: if a token was offered, the token decides. Only a request that offered
 * none falls back to the session.
 *
 * A banned account keeps its tokens but loses the use of them, exactly as on the
 * upload path — the token table has no notion of a disabled account, so the
 * check has to be here. The session branch needs no equivalent: Better Auth's
 * admin plugin will not hand a banned account a session to present.
 *
 * SCOPE. Every caller names the capability the call needs, and it is a required
 * argument rather than an option with a default: a route that forgot to say
 * would otherwise compile into an unscoped hole, which is precisely the state
 * this file existed in before. A SESSION is not scoped — a signed-in browser is
 * the account itself, and there is no cookie to narrow — so it satisfies every
 * capability and reports `scope: null`.
 */
export interface ApiCaller {
  id: string;
  /** "admin" for an administrator; whatever Better Auth stored otherwise. */
  role: string | null;
}

/**
 * The result of authenticating a route call.
 *
 * A refusal carries the status and the body rather than a bare null, because
 * "this token is real and is not allowed to do this" has to reach the wire as a
 * 403 naming the scope needed. Every route still renders it through its own
 * `json()`, so per-route cache headers and body shapes are untouched.
 */
export type ApiAuth<T> =
  | { ok: true; caller: T; scope: TokenScope | null }
  | { ok: false; status: number; body: Record<string, unknown> };

/** The 401 every token surface has always answered with. Unchanged wording. */
export const UNAUTHORIZED_BODY = { message: "Token not specified or not found." } as const;

function unauthorized<T>(): ApiAuth<T> {
  return { ok: false, status: 401, body: { ...UNAUTHORIZED_BODY } };
}

/** The JSON API's refusal wording, shared with lib/api-token.ts's mapping. */
function refusalFor(auth: Extract<TokenAuth, { ok: false }>) {
  return tokenRefusal(auth, UNAUTHORIZED_BODY.message);
}

export async function resolveApiCaller(
  req: Request,
  required: TokenCapability,
): Promise<ApiAuth<ApiCaller>> {
  const token = bearerFromRequest(req.headers);

  if (token) {
    const auth = await authenticateApiToken(token, required);
    if (!auth.ok) return { ok: false, ...refusalFor(auth) };
    return { ok: true, caller: { id: auth.user.id, role: auth.user.role ?? null }, scope: auth.scope };
  }

  const session = await getSession();
  if (!session) return unauthorized();
  return { ok: true, caller: { id: session.user.id, role: session.user.role ?? null }, scope: null };
}

/**
 * The same decision, but resolved to the WHOLE user row.
 *
 * Some routes need more than an id: anything that hands back a link has to know
 * the account's tag, its preferred hostname, whether it wants tagless URLs and
 * which of the two link shapes its `copy_raw` switch selects. None of that is in
 * Better Auth's session payload (the profile page loads it separately for the
 * same reason), and a link built without it is a link the account does not
 * actually use.
 *
 * Kept beside `resolveApiCaller` rather than folded into it: the lightweight
 * form answers the session branch with no query at all, and making every caller
 * pay for a SELECT it does not read would be a strange price for tidiness.
 *
 * The refusal rules are identical, and deliberately so - a second copy of "a
 * present-but-wrong token is a refusal, never a fall-through to the cookie" is a
 * second chance to get it wrong. tests/unit/api-route-auth.test.ts exercises
 * both through the routes that use them.
 */
export async function resolveApiOwner(
  req: Request,
  required: TokenCapability,
): Promise<ApiAuth<UserRow>> {
  const token = bearerFromRequest(req.headers);

  if (token) {
    const auth = await authenticateApiToken(token, required);
    if (!auth.ok) return { ok: false, ...refusalFor(auth) };
    return { ok: true, caller: auth.user, scope: auth.scope };
  }

  const session = await getSession();
  if (!session) return unauthorized();

  const [row] = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
  if (!row || row.banned) return unauthorized();
  return { ok: true, caller: row, scope: null };
}
