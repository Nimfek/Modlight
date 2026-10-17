import { describe, it, expect } from "vitest";
import nextConfig from "@/next.config";
import { renderCsp } from "@/lib/media/render-ticket";

/**
 * The one header that makes rendering an upload a feature instead of a hole.
 *
 * `/{tag}/{code}/render` is the only route in this app that may answer with
 * text/html taken from a file somebody uploaded. Without
 * `Content-Security-Policy: sandbox` on that response the document lands in OUR
 * origin, and a script in it can read the session cookie of whoever opened the
 * link - the owner's account and his five users. So the header is not a
 * hardening measure to be checked by review; it is the feature's precondition,
 * and it gets pinned like one.
 *
 * It is pinned HERE, against next.config, because that is the copy the browser
 * actually receives. Next applies these rules with setHeader before the route
 * handler runs and afterwards fills in only the keys the response does not
 * already carry, so the string the handler builds is discarded whenever this
 * rule matched. tests/unit/render-ticket.test.ts pins that fallback; this file
 * pins the one in force.
 */

interface Rule {
  source: string;
  headers: { key: string; value: string }[];
}

const RENDER_SOURCE = "/:userCode/:mediaCode/render";

async function rules(): Promise<Rule[]> {
  const headers = nextConfig.headers;
  expect(typeof headers, "next.config must define headers()").toBe("function");
  return (await headers!()) as Rule[];
}

function valueOf(rule: Rule, key: string): string | undefined {
  return rule.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
}

describe("the sandbox policy on the render route", () => {
  it("has a rule of its own", async () => {
    const matching = (await rules()).filter((r) => r.source === RENDER_SOURCE);
    expect(matching).toHaveLength(1);
  });

  it("sandboxes the response, which is what gives it an opaque origin", async () => {
    const rule = (await rules()).find((r) => r.source === RENDER_SOURCE)!;
    const csp = valueOf(rule, "Content-Security-Policy");
    expect(csp).toBeDefined();
    // Opaque origin: no cookies, no localStorage, no same-origin fetch, and it
    // holds for a direct navigation to the URL, not only inside our iframe.
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("never pairs allow-scripts with allow-same-origin", async () => {
    // Together they do not weaken the sandbox, they cancel it: the document can
    // reach into window.parent and strip the attribute off its own frame.
    const rule = (await rules()).find((r) => r.source === RENDER_SOURCE)!;
    const csp = valueOf(rule, "Content-Security-Policy")!;
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-top-navigation");
    expect(csp).not.toContain("allow-popups");
    expect(csp).not.toContain("allow-downloads");
    expect(csp).not.toContain("allow-modals");
  });

  it("sends nosniff, so the browser cannot re-guess the type", async () => {
    const rule = (await rules()).find((r) => r.source === RENDER_SOURCE)!;
    expect(valueOf(rule, "X-Content-Type-Options")).toBe("nosniff");
  });

  it("is declared AFTER the app-wide rule, which is what makes it win", async () => {
    // Both rules match this path and both set Content-Security-Policy. Next
    // applies them in order with setHeader, so the later declaration is the one
    // the browser sees. Move this rule above the catch-all and the sandbox
    // silently disappears while every other assertion here still passes.
    const all = await rules();
    const catchAll = all.findIndex((r) => r.source.startsWith("/:path("));
    const render = all.findIndex((r) => r.source === RENDER_SOURCE);
    expect(catchAll).toBeGreaterThanOrEqual(0);
    expect(render).toBeGreaterThan(catchAll);
  });

  it("agrees with the per-shape fallback the handler builds", async () => {
    // The two are written down separately (one cannot import the other: the
    // config is loaded by the Next CLI, the handler by the runtime). If they
    // ever disagree about the directive that matters, the comment explaining
    // which one wins has become fiction.
    const rule = (await rules()).find((r) => r.source === RENDER_SOURCE)!;
    const csp = valueOf(rule, "Content-Security-Policy")!;
    expect(csp.startsWith("sandbox")).toBe(true);
    expect(renderCsp("html").startsWith("sandbox")).toBe(true);
  });
});

describe("the raw route is not the render route", () => {
  it("still sandboxes /raw and never grants it scripts", async () => {
    // /raw serves the uploaded bytes as text/plain and always has. The owner's
    // request was about the preview page, not about this, and a rendered
    // preview must not have arrived by loosening it.
    const raw = (await rules()).filter((r) => r.source.includes("/raw"));
    expect(raw.length).toBeGreaterThan(0);
    for (const rule of raw) {
      const csp = valueOf(rule, "Content-Security-Policy")!;
      expect(csp, rule.source).toContain("sandbox");
      expect(csp, rule.source).not.toContain("allow-scripts");
      expect(csp, rule.source).not.toContain("allow-same-origin");
    }
  });
});
