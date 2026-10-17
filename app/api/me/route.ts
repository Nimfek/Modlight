import { resolveApiCaller } from "@/lib/api-caller";
import { capabilitiesOf, type TokenScope } from "@/lib/api-token";
import { db } from "@/lib/db";
import { user as users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isUnlimited } from "@/lib/quota";
import { userBaseUrl } from "@/lib/media/urls";
import { avatarUrl } from "@/lib/avatar";

/**
 * Who this token belongs to, and how much room is left.
 *
 * Exists for one concrete failure: the downloader companion queues a playlist,
 * spends forty minutes fetching six gigabytes, and only then discovers the
 * account had four left. `POST /upload` answers that with 507 — correctly, but
 * far too late to be useful. A client that can ask FIRST can tell the user
 * before the download starts, which is the difference between a warning and a
 * wasted evening.
 *
 * It is also how a client verifies a config file works ("connected as alicja")
 * without uploading a probe file into somebody's library.
 *
 * Returns nothing that is not already the caller's own — the role included:
 * an account already knows whether it administers the server.
 *
 * SCOPE: `identify`, which every scope grants. This is the one surface a token
 * of any width may reach, because it is how a client checks that its config
 * works at all - refusing it to an upload-only token would break the
 * test-connection button on exactly the tokens we want people to choose. It
 * answers with the token's own scope for the same reason: a client that can see
 * "this credential may only upload" can say so, instead of letting the user
 * discover it as an unexplained 403 three screens later.
 */

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
}

export async function GET(req: Request): Promise<Response> {
  const auth = await resolveApiCaller(req, "identify");
  if (!auth.ok) return json(auth.body, auth.status);
  const userId = auth.caller.id;
  const scope: TokenScope | null = auth.scope;

  const [row] = await db
    .select({
      name: users.name,
      email: users.email,
      userCode: users.userCode,
      image: users.image,
      usedQuota: users.usedQuota,
      maxQuota: users.maxQuota,
      copyRaw: users.copyRaw,
      hideUploads: users.hideUploads,
      defaultFolderId: users.defaultFolderId,
      preferredDomain: users.preferredDomain,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) return json({ message: "Token not specified or not found." }, 401);

  const used = Number(row.usedQuota ?? 0);
  const max = Number(row.maxQuota ?? -1);
  const unlimited = isUnlimited(max);
  const host = userBaseUrl(row.preferredDomain ?? null);
  // Absolute, unlike everywhere in the panel: a desktop client has no origin to
  // resolve a root-relative path against. Public and unauthenticated to fetch,
  // so the client can draw it without attaching a token to an <img>.
  const avatarPath = avatarUrl(row.userCode, row.image);

  return json({
    tag: row.userCode,
    // What the credential that asked may do. `null` for a browser session,
    // which is the account itself and has no scope to narrow.
    token: scope ? { scope, capabilities: capabilitiesOf(scope) } : null,
    name: row.name,
    email: row.email,
    avatar: avatarPath ? `${host}${avatarPath}` : null,
    // The hostname THIS account's links are built on, so a client can show the
    // user which deployment their config points at.
    host,
    quota: {
      used,
      // null rather than -1: a client doing arithmetic on the sentinel would
      // compute a negative allowance and refuse every upload.
      max: unlimited ? null : max,
      remaining: unlimited ? null : Math.max(0, max - used),
      unlimited,
    },
    // What this account is on the server. The desktop client reads it to decide
    // whether to OFFER an administration screen at all, and that is the only
    // thing it may be used for: every admin surface checks the role again on its
    // own, so a client that lied to itself here would earn a wall of refusals
    // rather than access to anything. Comes from the caller resolution rather
    // than the row above, so a token and a session answer from the same place.
    role: auth.caller.role ?? null,
    // Mirrors of panel preferences a client may want to reflect. The clipboard
    // choice is still answered per upload by `copy_url` — this is for showing
    // the setting, never for deciding it.
    copyRaw: row.copyRaw ?? false,
    hideUploads: row.hideUploads ?? false,
    defaultFolderId: row.defaultFolderId ?? null,
  });
}
