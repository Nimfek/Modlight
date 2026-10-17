import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Next 16 renamed middleware.ts -> proxy.ts.
 *
 * Two jobs, both cheap and neither authoritative:
 *
 *  1. An OPTIMISTIC dashboard gate (cookie presence only) — real authorization
 *     happens in each route/server component via requireUser()/requireAdmin().
 *  2. Host-based rewriting for the dedicated shortener domain.
 */

/**
 * Hostname that serves short links, from SHORTLINK_URL.
 *
 * Read straight from the environment rather than lib/config, because proxy.ts
 * runs in the edge-style middleware bundle and pulling the full config in would
 * drag the database client along with it.
 */
const SHORT_HOST = (() => {
  const raw = process.env.SHORTLINK_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
})();

/**
 * Paths that must keep working on the shortener host: certificate renewal,
 * health checks, framework assets, and the app's own API.
 */
const PASSTHROUGH = /^\/(?:_next|api|s\/|favicon|icon|apple-icon|robots|sitemap|\.well-known)/;

export function proxy(request: NextRequest) {
  const host = request.headers.get("host")?.split(":")[0]?.toLowerCase();
  const { pathname } = request.nextUrl;

  /**
   * On the shortener domain the short code IS the path: s.example.com/promo
   * instead of s.example.com/s/promo, and s.example.com/tag/promo for the
   * per-user form. Rewriting here means the /s/* routes stay the single
   * implementation — they keep answering on the main domain too, so links
   * shared before this existed still resolve.
   */
  if (SHORT_HOST && host === SHORT_HOST && pathname !== "/" && !PASSTHROUGH.test(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `/s${pathname}`;
    return NextResponse.rewrite(url);
  }

  if (pathname.startsWith("/dashboard")) {
    const hasSession = getSessionCookie(request);
    if (!hasSession) {
      const url = new URL("/login", request.url);
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Everything except framework internals and static files: the shortener
  // rewrite has to see bare paths, which the previous /dashboard-only matcher
  // never received.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
