"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createApiToken } from "@/lib/api-token";
import { getSession } from "@/lib/auth-helpers";
import { recordAudit } from "@/lib/audit";
import { checkRateLimit, clientIp } from "@/lib/password";
import { parseAuthorizeRequest, tokenNameFor } from "@/lib/authorize/loopback";

/**
 * Issuing an API token to a desktop client that asked for one over the loopback
 * flow (see lib/authorize/loopback.ts for the whole handshake).
 *
 * This is a POST — a Server Action always is — and that is not an implementation
 * detail. If approving were a GET, then merely OPENING a link would mint a
 * credential, and the link would be one an attacker writes: the whole flow rests
 * on a human looking at the prompt and choosing.
 */

/**
 * Why an approval was refused. Travels as data rather than as a thrown error:
 * Next masks Server Action error messages in production, so anything the user
 * has to read would reach them as "an error occurred".
 */
export type AuthorizeRefusal = "signed-out" | "invalid-request" | "rate-limited" | "error";

export type ApproveDesktopResult =
  | { ok: true; token: string; callback: string; state: string }
  | { ok: false; reason: AuthorizeRefusal };

/** Minting credentials is rare; a flood of it is somebody else's script. */
const MAX_APPROVALS = 10;
const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Mint a named API token for a desktop client and hand back where to deliver it.
 *
 * The arguments are the RAW query values the prompt was rendered from, and they
 * are re-validated here from scratch. A Server Action is a public endpoint that
 * anything can call with anything: the page having checked them earlier says
 * nothing about what arrives now, and `callback` is built from the port this
 * function parsed, never from a URL the caller supplied.
 */
export async function approveDesktopClient(input: {
  port: string;
  state: string;
  name: string;
}): Promise<ApproveDesktopResult> {
  // Deliberately not `requireUser()`: that redirects to /login, and a redirect
  // out of an action the user just clicked loses the request they were
  // approving. The page tells them to sign in again instead.
  const session = await getSession();
  if (!session) return { ok: false, reason: "signed-out" };

  const parsed = parseAuthorizeRequest({
    port: input?.port,
    state: input?.state,
    name: input?.name,
  });
  if (!parsed.ok) return { ok: false, reason: "invalid-request" };

  // Keyed by caller AND account: one compromised session cannot be milked for
  // tokens in a loop, and one noisy IP cannot lock out everybody behind it.
  const key = `${clientIp(await headers())}|authorize:${session.user.id}`;
  if (!checkRateLimit(key, MAX_APPROVALS, APPROVAL_WINDOW_MS).allowed) {
    return { ok: false, reason: "rate-limited" };
  }

  const { request } = parsed;

  try {
    // SCOPE: `write`. The desktop client uploads, draws the library, moves
    // files between folders and empties the trash - that is `write`, and
    // nothing here needs `full`: publishing a release is a deliberate,
    // separate act by an administrator, not something a sign-in should hand
    // out. A client that later needs more says so by asking for another token.
    const token = await createApiToken(session.user.id, tokenNameFor(request.clientName), "write");

    // A credential was issued, so it gets a line in the log — with the name the
    // client claimed and the port it asked for, because "which of these did I
    // approve" is the question this entry has to answer later. The last six
    // characters are the same ones `api_tokens.preview` already stores and the
    // Integrations page already shows, so the log points at a specific row
    // without holding anything that could be used as the token.
    await recordAudit(session.user.id, "api_token.authorized", {
      client: request.clientName || null,
      port: request.port,
      preview: token.slice(-6),
    });

    revalidatePath("/dashboard/tokens");
    return { ok: true, token, callback: request.callback, state: request.state };
  } catch (err) {
    console.error("[authorize] could not issue a desktop token:", err);
    return { ok: false, reason: "error" };
  }
}
