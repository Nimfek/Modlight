import { getMedia, type MediaRow } from "@/lib/media/serve";
import { deleteMediaHard } from "@/lib/media/actions";
import { authenticateApiToken } from "@/lib/api-token";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ userCode: string; mediaCode: string; token: string }> };

/**
 * Two different credentials open this page, and only one of them is a link.
 *
 * The per-media `deleteToken` is the one baked into `.sxcu`'s DeletionURL and
 * handed to other people; it deletes exactly the file it names and nothing else.
 * The second branch accepts an ACCOUNT API token in the same slot, which is a
 * far larger key: `/{tag}/{code}/delete/{apiToken}` works for every file the
 * account owns, and it deletes for good — no trash, no undo. That is the shape
 * of the problem this whole change exists for, so it needs the `write`
 * capability. A `read` or `upload` token in that slot is now simply not a
 * credential here, and falls through to the same 404 a wrong string gets.
 *
 * 404 rather than 403 on the refusal, unlike the JSON API: this URL is public
 * and unguessable, and answering "that is the right file but the wrong key"
 * would turn it into an oracle for which codes exist.
 */
async function authorized(media: MediaRow, token: string): Promise<boolean> {
  if (token && media.deleteToken && token === media.deleteToken) return true;
  const auth = await authenticateApiToken(token, "write");
  return auth.ok && auth.user.id === media.ownerId;
}

/**
 * Escape a value for interpolation into HTML text.
 *
 * This page is hand-built HTML rather than React, so nothing escapes for us.
 * `media.filename` comes straight off the multipart upload and is stored as-is
 * (varchar 512) — a name like `<img src=x onerror=...>` would otherwise execute
 * on this origin, in the session of whoever opened the deletion link. The link
 * is designed to be handed to other people, so this is not self-XSS: an attacker
 * uploads the file, receives its deletion URL, and sends it to a victim.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * `body` is trusted markup assembled below; every value coming from the
 * database or the request must pass through `esc()` before it gets here.
 */
function page(title: string, body: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - ${esc(config.appName)}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#fafafa;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
<div style="max-width:420px;width:90%;background:#151517;border:1px solid #26262a;border-radius:16px;padding:28px;text-align:center">
<div style="font-weight:700;margin-bottom:12px">${esc(config.appName)}</div>${body}</div></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Belt and braces: even if something unescaped slips in later, this page
      // has no legitimate need to run script or be framed.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(_req: Request, ctx: Params): Promise<Response> {
  const { userCode, mediaCode, token } = await ctx.params;
  const found = await getMedia(userCode, mediaCode);
  if (!found || !(await authorized(found.media, token))) return new Response("Not found", { status: 404 });
  return page("Delete file", `
    <p style="color:#a1a1aa;font-size:14px;line-height:1.6">Delete <b style="color:#fafafa">${esc(found.media.filename)}</b> permanently? This cannot be undone.</p>
    <form method="post" style="margin-top:18px">
      <button type="submit" style="background:#ef4444;color:#fff;border:0;border-radius:10px;padding:11px 22px;font-weight:600;cursor:pointer">Delete permanently</button>
    </form>`);
}

export async function POST(_req: Request, ctx: Params): Promise<Response> {
  const { userCode, mediaCode, token } = await ctx.params;
  const found = await getMedia(userCode, mediaCode);
  if (!found || !(await authorized(found.media, token))) return new Response("Not found", { status: 404 });
  await deleteMediaHard(found.media);
  return page("Deleted", `<p style="color:#a1a1aa;font-size:14px">The file has been deleted.</p>`);
}
