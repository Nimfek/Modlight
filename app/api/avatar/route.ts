import { getSession } from "@/lib/auth-helpers";
import { AVATAR_MAX_BYTES, isAcceptedAvatarType } from "@/lib/avatar";
import { clearAvatar, saveAvatar } from "@/lib/avatar-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Set the signed-in account's avatar from a file on their machine.
 *
 * A route handler rather than a Server Action for the same reason
 * app/api/background/route.ts is one: actions cap the request body at 1 MB, and
 * images are not. The bytes arrive as the raw body (no multipart), so there is
 * nothing to parse.
 *
 * Picking an image the account has ALREADY uploaded goes through
 * app/actions/avatar.ts instead: that request carries an id, not a file, so it
 * fits an action comfortably and gets ownership scoping and revalidation for
 * free.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);

  const type = req.headers.get("content-type");
  if (!isAcceptedAvatarType(type)) return json({ error: "type" }, 415);

  // Declared length first: refusing before reading is the difference between
  // rejecting a 2 GB body and buffering it in order to reject it.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES) {
    return json({ error: "too-large" }, 413);
  }

  const input = Buffer.from(await req.arrayBuffer());
  // A body may arrive chunked with no Content-Length, so the real size is
  // checked again once it is in hand.
  if (input.byteLength === 0) return json({ error: "empty" }, 400);
  if (input.byteLength > AVATAR_MAX_BYTES) return json({ error: "too-large" }, 413);

  const result = await saveAvatar(session.user.id, input, { signal: req.signal });
  if (!result.ok) {
    switch (result.error) {
      case "busy":
        return json({ error: "busy" }, 503);
      case "aborted":
        return new Response(null, { status: 499 });
      case "too-many-pixels":
        return json({ error: "too-many-pixels" }, 413);
      default:
        return json({ error: "decode" }, 400);
    }
  }

  return json({
    ok: true,
    url: result.url,
    bytes: result.bytes,
    animated: result.animated,
    // Present when the source was animated and the stored avatar is not, so the
    // panel can say why instead of showing a frozen picture and nothing else.
    degraded: result.degraded,
  });
}

/** Remove the avatar and go back to initials. */
export async function DELETE(): Promise<Response> {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized" }, 401);

  await clearAvatar(session.user.id);
  return json({ ok: true });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
