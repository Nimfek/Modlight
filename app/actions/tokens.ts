"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth-helpers";
import { recordAudit } from "@/lib/audit";
import {
  createApiToken,
  isTokenScope,
  listApiTokens,
  narrowApiTokenScope,
  revokeApiToken,
  type TokenScope,
} from "@/lib/api-token";

/**
 * The scope a client gets when the caller did not choose one.
 *
 * `upload` and not `full`, because this is the value most people will end up
 * with: the one-click ShareX button never asks, and a form field can always
 * arrive empty. The safe end of the range is the one an omission should land on.
 */
const DEFAULT_SCOPE: TokenScope = "upload";

/**
 * Create a new API token. Returns the PLAINTEXT token (shown once).
 *
 * The scope is validated here rather than trusted, because a Server Action is a
 * public endpoint: the picker in the dialog is a suggestion, and anything can
 * post any string at this. An unrecognised value is NOT widened to `full` and
 * not silently accepted either - it falls to the narrowest scope, which is the
 * only direction a guess is allowed to go.
 */
export async function createUploadToken(
  name: string,
  scope?: string,
): Promise<{ token: string; scope: TokenScope }> {
  const session = await requireUser();
  const chosen: TokenScope = isTokenScope(scope) ? scope : DEFAULT_SCOPE;
  const token = await createApiToken(session.user.id, name?.trim() || "ShareX", chosen);
  revalidatePath("/dashboard/tokens");
  return { token, scope: chosen };
}

export async function revokeUploadToken(id: string): Promise<void> {
  const session = await requireUser();
  await revokeApiToken(id, session.user.id);
  revalidatePath("/dashboard/tokens");
}

/**
 * Narrow a live token's scope. Never widen it.
 *
 * A widening in place would be a privilege escalation with no new secret
 * involved: whoever holds a leaked read-only token would promote it to `write`
 * and delete the library it was only ever meant to show. Growing a token's reach
 * therefore means creating a new one, which produces a new string, which the
 * person who leaked the old one does not have.
 *
 * The refusal is enforced in `narrowApiTokenScope` (inside the WHERE clause, so
 * two concurrent narrowings cannot interleave into a widening) rather than only
 * in the UI. The UI only offers legal choices; this decides.
 */
export async function narrowTokenScope(
  id: string,
  scope: string,
  // The result type is written out rather than exported as a named alias: in a
  // "use server" module every export is a live endpoint, so a type alias here
  // would be one more thing the Next compiler has to be persuaded is not one.
): Promise<{ ok: true; scope: TokenScope } | { ok: false; reason: string }> {
  const session = await requireUser();
  if (!isTokenScope(scope)) return { ok: false, reason: "not-narrower" };

  const result = await narrowApiTokenScope(id, session.user.id, scope);
  if (!result.ok) return { ok: false, reason: result.reason };

  // A credential's reach changed, so it gets a line in the log. Only the last
  // six characters go in, which is what `api_tokens.preview` already stores and
  // the Integrations page already shows: enough to point at one row, useless as
  // a credential.
  await recordAudit(session.user.id, "api_token.narrowed", { token: id, scope: result.scope });

  revalidatePath("/dashboard/tokens");
  return { ok: true, scope: result.scope };
}

export async function myTokens() {
  const session = await requireUser();
  return listApiTokens(session.user.id);
}
