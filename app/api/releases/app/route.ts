import { currentRelease, publishRelease, APP_NAME } from "@/lib/releases";
import { authenticateApiToken, bearerFromRequest, tokenRefusal } from "@/lib/api-token";
import { getSession } from "@/lib/auth-helpers";
import { recordAudit } from "@/lib/audit";

/**
 * The update manifest for Modlight App, and the endpoint that publishes it.
 *
 * GET is deliberately PUBLIC and unauthenticated: every installed copy of the
 * app polls it on startup, and an updater that needed a credential to discover
 * a new version would stop working the moment a token was rotated — which is
 * the one time you most want people to be on a current build.
 *
 * POST is for an administrator, by session (the panel) or by API token (a
 * release script). It only ever names an upload that already exists.
 */

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200, cache = "public, max-age=300"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": cache },
  });
}

export async function GET(): Promise<Response> {
  const manifest = await currentRelease();
  if (!manifest) {
    // 404 rather than an empty 200: an updater checking for "is there a build"
    // should not have to inspect a body to find out.
    return json({ name: APP_NAME, message: "No release published." }, 404, "no-store");
  }
  // Five minutes of shared caching. The manifest is public and identical for
  // everybody, and a release does not appear so urgently that a stale answer
  // for one poll interval costs anything.
  return json(manifest, 200, "public, max-age=300");
}

type AdminCaller =
  | { ok: true; id: string; email: string }
  | { ok: false; status: number; body: Record<string, unknown> };

const NOT_ADMIN = { message: "Administrator credentials required." };

/**
 * Admin, by API token first and session second — same order as /api/folders.
 *
 * TWO gates, and they are not the same gate. `admin` is the token's SCOPE: a
 * release script needs a credential explicitly issued to publish, so an
 * administrator's ordinary `write` token - the one in their own desktop app -
 * cannot push a build to every installation just because of who owns it. The
 * role check that follows is the ACCOUNT's: a `full` token belonging to a
 * regular user grants everything that user has, and publishing releases is not
 * among it.
 */
async function requireAdminCaller(req: Request): Promise<AdminCaller> {
  const token = bearerFromRequest(req.headers);
  if (token) {
    const auth = await authenticateApiToken(token, "admin");
    if (!auth.ok) {
      const { status, body } = tokenRefusal(auth, NOT_ADMIN.message);
      return { ok: false, status, body };
    }
    if (auth.user.role !== "admin") return { ok: false, status: 401, body: { ...NOT_ADMIN } };
    return { ok: true, id: auth.user.id, email: auth.user.email };
  }
  const session = await getSession();
  if (!session || session.user.role !== "admin") {
    return { ok: false, status: 401, body: { ...NOT_ADMIN } };
  }
  return { ok: true, id: session.user.id, email: session.user.email };
}

export async function POST(req: Request): Promise<Response> {
  const admin = await requireAdminCaller(req);
  if (!admin.ok) return json(admin.body, admin.status, "no-store");

  let body: { version?: unknown; code?: unknown; notes?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ message: "Expected a JSON body." }, 400, "no-store");
  }

  if (typeof body.version !== "string" || typeof body.code !== "string") {
    return json({ message: "version and code are required." }, 400, "no-store");
  }

  const result = await publishRelease({
    version: body.version,
    code: body.code,
    notes: typeof body.notes === "string" ? body.notes : undefined,
    // Strictly opt-in, and only the literal true. A build script that means to
    // override should have to say so; anything falsy keeps the guard.
    allowVersionMismatch: (body as { allowVersionMismatch?: unknown }).allowVersionMismatch === true,
  });

  if (!result.ok) {
    const status = result.reason === "not-found" ? 404 : 400;
    const message =
      result.reason === "not-found"
        ? "No such upload."
        : result.reason === "not-public"
          ? "That upload is not publicly downloadable (unpublished, password-protected or expiring)."
          : result.reason === "bad-version"
            ? "version must be Major.Minor[.Build[.Revision]] - that is all an installed client can parse."
            : result.reason === "version-mismatch"
              ? `The file is named ${result.filename}, which says version ${result.fileVersion}. Fix the version, or repeat the request with allowVersionMismatch: true.`
              : "version and code are required.";
    return json({ message, reason: result.reason }, status, "no-store");
  }

  await recordAudit(admin.id, "release.published", {
    by: admin.id,
    byEmail: admin.email,
    version: result.manifest.version,
    code: body.code,
  });

  return json(result.manifest, 200, "no-store");
}
