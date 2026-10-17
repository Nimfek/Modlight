import type { TokenAuth, TokenCapability, TokenScope } from "@/lib/api-token";

/**
 * Builders for the shape `authenticateApiToken` answers with.
 *
 * They exist so a test that only cares about "a valid token" does not have to
 * restate the union every time - and, more usefully, so the day the union grows
 * a member, one file stops compiling instead of eight.
 *
 * `scope` defaults to `full` because most tests are about something other than
 * scopes and want a credential that simply works; the scope tests pass it
 * explicitly.
 */
type FakeUser = { id: string; banned?: boolean; role?: string | null } & Record<string, unknown>;

export function tokenOk(user: FakeUser, scope: TokenScope = "full"): TokenAuth {
  return { ok: true, user: user as never, scope };
}

/** No such token, or revoked. The 401 every surface has always answered with. */
export function tokenUnknown(): TokenAuth {
  return { ok: false, reason: "unknown" };
}

export function tokenBanned(user: FakeUser): TokenAuth {
  return { ok: false, reason: "banned", user: user as never };
}

/** A real token whose scope does not reach this call: the 403 case. */
export function tokenScoped(
  user: FakeUser,
  scope: TokenScope,
  required: TokenCapability,
): TokenAuth {
  return { ok: false, reason: "scope", scope, required, user: user as never };
}

/** A stored scope string this build does not know. Always a refusal. */
export function tokenInvalidScope(): TokenAuth {
  return { ok: false, reason: "invalid-scope" };
}
