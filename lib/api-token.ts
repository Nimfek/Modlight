import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiTokens, user as users } from "@/lib/db/schema";
import { secureToken } from "@/lib/ids";
import {
  isTokenScope,
  SCOPE_FOR,
  scopeGrants,
  isNarrowing,
  type TokenCapability,
  type TokenScope,
} from "@/lib/api-scopes";

export type UserRow = typeof users.$inferSelect;

export {
  TOKEN_SCOPES,
  SCOPE_FOR,
  LEGACY_TOKEN_SCOPE,
  isTokenScope,
  capabilitiesOf,
  scopeGrants,
  isNarrowing,
  narrowerScopes,
  type TokenScope,
  type TokenCapability,
} from "@/lib/api-scopes";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Pull an API token out of a WEB `Headers` (route handlers, Server Actions).
 *
 * The same rule as `bearerFromHeaders` in lib/upload/sharex.ts, which reads a
 * Node `IncomingHttpHeaders` instead — the raw upload path never sees a web
 * Request, and this one never sees a Node one, so the two shapes each need an
 * adapter even though the rule is one rule.
 *
 * `x-api-key` wins, but only when it carries something: a header that is present
 * and EMPTY must fall through to `Authorization`, not swallow it. Writing this
 * as `get("x-api-key") ?? bearer` looked equivalent and was not — `??` only
 * falls through on null, so an empty header (which every HTTP client will
 * happily send when its config field is blank) silently disabled the Bearer
 * branch and the caller got 401 while holding a perfectly good token.
 */
export function bearerFromRequest(headers: Headers): string | null {
  const xApi = headers.get("x-api-key")?.trim();
  if (xApi) return xApi;

  const auth = headers.get("authorization")?.trim();
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || null;
  }
  return null;
}

/**
 * The outcome of presenting a token at a surface that needs `required`.
 *
 * A union rather than `UserRow | null` because the three refusals are three
 * different things to a human debugging a client: "this token does not exist"
 * (401), "this account is switched off" (401), and "this token is real and is
 * not allowed to do this" (403, and it says which scope would be). Collapsing
 * the third into the first is exactly the bare 401 that sends somebody
 * regenerating a perfectly good ShareX config.
 */
export type TokenAuth =
  | { ok: true; user: UserRow; scope: TokenScope }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "banned"; user: UserRow }
  | { ok: false; reason: "invalid-scope" }
  | { ok: false; reason: "scope"; scope: TokenScope; required: TokenCapability; user: UserRow };

/**
 * Verify a token, check it may do `required`, and return its owner — stamping
 * `last_used_at` on the way. Used at the raw server layer for ShareX uploads
 * too, so it stays one indexed lookup plus one row read.
 *
 * The stamp is part of the *same* statement that resolves the token, on purpose.
 * An earlier version did the lookup with a SELECT and fired the timestamp off
 * as `void db.update(...)` — but a Drizzle query builder is a LAZY thenable: it
 * only reaches the database when something calls `.then()`. `void` never does,
 * so the UPDATE was built and thrown away and every `api_tokens.last_used_at`
 * in production stayed NULL while uploads worked perfectly. Doing it as
 * `UPDATE … RETURNING` costs exactly the same one round-trip as the SELECT did
 * and cannot be silently skipped, whichever path authenticated.
 *
 * The stamp lands even when the scope check then refuses. "Last used" is a fact
 * about the credential having been presented, and a token being refused over
 * and over is precisely the state you want to be able to see.
 *
 * FAIL CLOSED on the scope column. A value this build does not recognise is a
 * refusal, never a fallback to something permissive: the only way such a row can
 * exist is a downgrade or a hand-edited database, and in both cases guessing
 * would guess in the attacker's favour. Legacy rows do not reach this branch —
 * the migration backfills every one of them to `full`.
 */
export async function authenticateApiToken(
  token: string | null | undefined,
  required: TokenCapability,
): Promise<TokenAuth> {
  if (!token) return { ok: false, reason: "unknown" };

  const rows = await db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiTokens.tokenHash, hashToken(token)), isNull(apiTokens.revokedAt)))
    .returning({ userId: apiTokens.userId, scope: apiTokens.scope });

  const tok = rows[0];
  if (!tok) return { ok: false, reason: "unknown" };
  if (!isTokenScope(tok.scope)) return { ok: false, reason: "invalid-scope" };

  const [owner] = await db.select().from(users).where(eq(users.id, tok.userId)).limit(1);
  if (!owner) return { ok: false, reason: "unknown" };

  // A banned account keeps its tokens and loses the use of them. Checked before
  // the scope so a disabled account is told it is disabled rather than being
  // sent off to mint a wider token that would not work either.
  if (owner.banned) return { ok: false, reason: "banned", user: owner };

  if (!scopeGrants(tok.scope, required)) {
    return { ok: false, reason: "scope", scope: tok.scope, required, user: owner };
  }

  return { ok: true, user: owner, scope: tok.scope };
}

/**
 * The body of a scope refusal, identical on every surface — including the raw
 * ShareX endpoint, which is not a route handler and would otherwise have grown
 * its own wording.
 *
 * `reason` is the machine-readable contract; `message` is for the human reading
 * a client's debug log, which is the whole reason this is a 403 with a body and
 * not a 401 with nothing.
 */
export function scopeRefusalBody(auth: Extract<TokenAuth, { reason: "scope" }>): {
  message: string;
  reason: "insufficient_scope";
  scope: TokenScope;
  required_scope: TokenScope;
} {
  const needed = SCOPE_FOR[auth.required];
  return {
    message: `This API token is scoped to "${auth.scope}" and this call needs "${needed}". Create a token with the "${needed}" scope (or wider) in Integrations.`,
    reason: "insufficient_scope",
    scope: auth.scope,
    required_scope: needed,
  };
}

/** The body of an unrecognised-scope refusal. Also a 403: the token is real. */
export function invalidScopeBody(): { message: string; reason: "invalid_scope" } {
  return {
    message:
      "This API token carries a scope this server does not recognise and has been refused. Create a new token in Integrations.",
    reason: "invalid_scope",
  };
}

/**
 * Turn any token refusal into the status and body it reaches the wire as.
 *
 * Lives HERE rather than in lib/api-caller.ts because the raw ShareX endpoint
 * needs it too, and lib/api-caller.ts is unreachable from server.ts by design
 * (it imports `server-only`, a specifier esbuild passes through untouched and
 * Node then cannot resolve — the container would die before `listen()`). This
 * module is already on the custom server's import graph, so one copy of the
 * wording serves the busboy handler, the tus hooks and every route handler
 * alike: a client author debugging one surface should never discover that
 * another phrases the same refusal differently.
 */
export function tokenRefusal(
  auth: Extract<TokenAuth, { ok: false }>,
  /**
   * Wording for "no such token". Supplied by the caller because it is the one
   * line that is NOT shared: `POST /upload` answers the exact
   * "Token specified not found." that existing ShareX configs expect, while the JSON API
   * answers "Token not specified or not found." and has done since it existed.
   * Changing either would break a client that matches on it.
   */
  unknownMessage: string,
): { status: number; body: Record<string, unknown> } {
  switch (auth.reason) {
    case "scope":
      return { status: 403, body: { ...scopeRefusalBody(auth) } };
    case "invalid-scope":
      return { status: 403, body: { ...invalidScopeBody() } };
    case "banned":
      return { status: 401, body: { message: "Account disabled." } };
    default:
      return { status: 401, body: { message: unknownMessage } };
  }
}

/**
 * Create a new API token. Returns the PLAINTEXT token (shown once).
 *
 * `scope` has no default. A default here would be the one place a caller could
 * quietly mint a `full` token by omission, which is the failure this whole
 * change exists to remove — so every caller says out loud what it is issuing.
 */
export async function createApiToken(
  userId: string,
  name: string,
  scope: TokenScope,
): Promise<string> {
  const token = secureToken(24); // ~32 url-safe chars
  await db.insert(apiTokens).values({
    userId,
    name,
    scope,
    tokenHash: hashToken(token),
    preview: token.slice(-6),
  });
  return token;
}

/** List a user's tokens (without secrets). */
export async function listApiTokens(userId: string) {
  return db.select().from(apiTokens).where(eq(apiTokens.userId, userId));
}

export async function revokeApiToken(id: string, userId: string): Promise<void> {
  await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)));
}

export type NarrowResult =
  | { ok: true; scope: TokenScope }
  | { ok: false; reason: "not-found" | "revoked" | "not-narrower" };

/**
 * Narrow a live token's scope in place.
 *
 * Widening is refused here rather than only in the UI, because the UI is a
 * suggestion and a Server Action is a public endpoint: anything can call this
 * with any pair of arguments. The current scope is read inside the same
 * statement's WHERE (`scope = current`), so two concurrent narrowings cannot
 * interleave into a widening — the loser matches nothing and is told so.
 */
export async function narrowApiTokenScope(
  id: string,
  userId: string,
  next: TokenScope,
): Promise<NarrowResult> {
  const [row] = await db
    .select({ scope: apiTokens.scope, revokedAt: apiTokens.revokedAt })
    .from(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
    .limit(1);

  if (!row) return { ok: false, reason: "not-found" };
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  // An unrecognised stored value cannot be compared, so it cannot be narrowed
  // "safely" either. Refuse rather than treat it as anything.
  if (!isTokenScope(row.scope)) return { ok: false, reason: "not-narrower" };
  if (!isNarrowing(row.scope, next)) return { ok: false, reason: "not-narrower" };

  const [updated] = await db
    .update(apiTokens)
    .set({ scope: next })
    .where(
      and(
        eq(apiTokens.id, id),
        eq(apiTokens.userId, userId),
        eq(apiTokens.scope, row.scope),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning({ scope: apiTokens.scope });

  if (!updated) return { ok: false, reason: "not-narrower" };
  return { ok: true, scope: next };
}
