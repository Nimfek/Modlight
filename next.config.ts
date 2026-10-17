import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// next-intl without URL routing — locale resolved per request in ./i18n/request.ts
const withNextIntl = createNextIntlPlugin();

const isDev = process.env.NODE_ENV !== "production";

/**
 * App CSP.
 *
 * 'unsafe-inline' for styles and scripts is deliberate: a nonce would have to be
 * minted per request in proxy.ts, and that file buffers request bodies — exactly
 * what the upload paths must stay away from. Dev additionally needs 'unsafe-eval'
 * and websockets for Turbopack HMR.
 *
 * frame-ancestors is 'self' rather than 'none' because the preview page embeds
 * its own /raw URL in an iframe to render PDFs.
 */
/**
 * Every origin this deployment serves on: APP_URL plus APP_DOMAINS plus the
 * shortener. A user's links are generated on the hostname they chose, so the
 * panel on one domain routinely references media on another — with `'self'`
 * alone the browser blocks those silently and thumbnails just never appear.
 */
const selfOrigins = (() => {
  const raw = [
    process.env.APP_URL,
    process.env.SHORTLINK_URL,
    ...(process.env.APP_DOMAINS ?? "").split(","),
  ];
  const origins = new Set<string>();
  for (const value of raw) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      /* ignore malformed entries rather than breaking the build */
    }
  }
  return [...origins].join(" ");
})();

/** `'self'` plus our other hostnames, ready to splice into a directive. */
const ownOrigins = `'self'${selfOrigins ? " " + selfOrigins : ""}`;

const appCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  `img-src ${ownOrigins} data: blob:`,
  `media-src ${ownOrigins} blob:`,
  // Without this, frame-src falls back to default-src 'self' and the PDF iframe
  // breaks whenever the visitor is on a different one of our hostnames than the
  // owner generates links with. The sandboxed HTML preview frames a relative
  // path, so it is covered by 'self' either way.
  `frame-src ${ownOrigins}`,
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'",
  isDev ? `connect-src ${ownOrigins} ws: wss:` : `connect-src ${ownOrigins}`,
].join("; ");

/**
 * `/authorize` needs one thing the rest of the app must never have: permission to
 * talk to a port on this machine.
 *
 * That page's entire job is the RFC 8252 loopback handoff — it POSTs the freshly
 * minted token to the desktop app listening on 127.0.0.1. Under `appCsp` the
 * browser refuses that fetch before it leaves, and the failure is invisible from
 * the server: the token is minted and audited, the page reports "your app did not
 * answer", and the user is told to paste the token by hand. It was reported as a
 * broken desktop listener; the listener was answering fine.
 *
 * The port is chosen per launch, so no static list can name it — hence the port
 * wildcard, which CSP allows. The widening is deliberately scoped to this ONE
 * path: `connect-src http://127.0.0.1:*` on every page would mean an XSS anywhere
 * in the app could reach every service on the user's machine.
 *
 * NOTE: this policy REPLACES appCsp for /authorize rather than joining it. Two
 * Content-Security-Policy headers are enforced as an INTERSECTION, so adding a
 * second, looser one changes nothing — the blanket rule below has to stop
 * matching this path for the wildcard to take effect.
 */
const authorizeCsp = appCsp.replace(
  isDev ? `connect-src ${ownOrigins} ws: wss:` : `connect-src ${ownOrigins}`,
  isDev
    ? `connect-src ${ownOrigins} http://127.0.0.1:* ws: wss:`
    : `connect-src ${ownOrigins} http://127.0.0.1:*`,
);

/**
 * User-uploaded bytes get a policy of their own: no scripts, no subresources
 * beyond the file itself, and `sandbox` so the document runs in an opaque
 * origin. Together with the inline-type allowlist in lib/media/mime.ts this is
 * the second line of defence against a malicious upload acting on our domain.
 */
const rawCsp = [
  "default-src 'none'",
  "img-src 'self' data:",
  "media-src 'self'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'self'",
  "sandbox",
].join("; ");

/**
 * The policy that actually sandboxes the HTML/SVG preview - this one, not the
 * per-type string in lib/media/render-ticket.ts. Next sets these config headers
 * before the route handler runs and afterwards only fills in keys the response
 * lacks, so for Content-Security-Policy the config always wins.
 *
 * Because a header rule is matched against the RAW request path while the App
 * Router hands the handler a DECODED segment, `/{tag}/{code}/%72ender` would
 * reach the render code WITHOUT matching this rule. That gap is closed in the
 * handler, which refuses any path not spelled literally `/render` - the two have
 * to be read together.
 *
 * `allow-scripts` is what makes "Show page" mean anything; SVG is held to a
 * stricter standard by its iframe's sandbox="" attribute, which intersects with
 * this and cannot be loosened by it.
 */
const renderCsp = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join("; ");

const baseSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Pin the browser to HTTPS for a year. Every domain here is HTTPS-only with a
  // renewing certificate, so there is no plain-HTTP deployment to strand — and
  // without this, the first request after typing the host by hand still goes out
  // in the clear, session cookie and all.
  //
  // `preload` is deliberately omitted: getting onto the browsers' preload list
  // is easy and getting off it takes months, which is the wrong trade for a
  // domain that also serves unrelated sites.
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  // Legacy companion to frame-ancestors; SAMEORIGIN keeps the PDF iframe alive.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Pin the Turbopack workspace root to THIS dir. pnpm-workspace.yaml + the
  // custom-server layout can make Turbopack infer the wrong root ("Next.js
  // package not found"). import.meta.dirname is the project root.
  turbopack: { root: import.meta.dirname },

  // We run our OWN Node server (server.ts) so /upload (ShareX) and /api/files
  // (tus) can stream multi-GB bodies at the raw layer. A custom server is
  // incompatible with output:'standalone' — do NOT set it.

  // Keep these out of the bundle:
  //  - sharp: native libvips binary must load at runtime
  //  - better-auth (+ kysely): server-only; Turbopack mis-analyzes kysely's CJS
  //    named exports, so let Node resolve them natively at runtime.
  //  - archiver: CJS with dynamic requires (album ZIP streaming) — resolve at runtime.
  serverExternalPackages: ["sharp", "better-auth", "@better-auth/kysely-adapter", "kysely", "archiver"],

  images: {
    // Media is served by our own routes; no remote image hosts needed (yet).
    remotePatterns: [],
  },

  async headers() {
    return [
      // Everything EXCEPT /authorize. The exclusion is not tidiness: a second CSP
      // header does not loosen the first (browsers intersect them), so the only
      // way /authorize can reach the loopback port is for this rule to miss it.
      {
        source: "/:path((?!authorize$|authorize/).*)",
        headers: [
          ...baseSecurityHeaders,
          { key: "Content-Security-Policy", value: appCsp },
        ],
      },
      {
        source: "/authorize",
        headers: [
          ...baseSecurityHeaders,
          { key: "Content-Security-Policy", value: authorizeCsp },
        ],
      },
      // Raw file delivery: /{userCode}/{code}/raw, /raw.png, /download
      ...["/:userCode/:mediaCode/raw", "/:userCode/:mediaCode/raw.:ext", "/:userCode/:mediaCode/download"].map(
        (source) => ({
          source,
          headers: [
            ...baseSecurityHeaders,
            { key: "Content-Security-Policy", value: rawCsp },
          ],
        }),
      ),
      // Sandboxed render of an uploaded page: /{userCode}/{code}/render
      {
        source: "/:userCode/:mediaCode/render",
        headers: [
          ...baseSecurityHeaders,
          { key: "Content-Security-Policy", value: renderCsp },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
