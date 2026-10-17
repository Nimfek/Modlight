import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * "Which surfaces accept an API token, and does every one of them check a
 * scope?" - asked of the source tree rather than of a list somebody maintains
 * by hand.
 *
 * A list in a comment goes stale the first time a route is added in a hurry, and
 * the failure it hides is silent: the new endpoint works, nobody notices it
 * takes any token at all, and the narrow scopes stop meaning what the Integrations
 * page says they mean. So this walks the tree instead, and it fails in BOTH
 * directions - an unscoped call site, and a surface that appears or disappears
 * without the inventory below being updated.
 *
 * The type system does most of the work already (the capability is a required
 * argument, so a call that names none does not compile). What it cannot catch is
 * a route that passes a capability WIDER or NARROWER than what it does, and what
 * it cannot show is the inventory itself - which is the thing a reviewer needs to
 * see in one place.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const ENTRY = /\b(authenticateApiToken|resolveApiCaller|resolveApiOwner)\s*\(/g;
const CAPABILITY = /"(identify|upload|read|write|admin)"/;

/**
 * Two files are not surfaces.
 *
 * lib/api-token.ts DECLARES the function, so its parameter list matches the same
 * pattern a call does. lib/api-caller.ts is the one file allowed to pass a
 * capability it did not choose: it forwards whatever its own callers named,
 * which is exactly its job.
 */
const FORWARDERS = new Set(["lib/api-token.ts", "lib/api-caller.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Every source file that resolves an API-token caller, and how it does it. */
function surfaces(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of ["app", "lib"]) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      const calls: string[] = [];
      for (const match of src.matchAll(ENTRY)) {
        // The argument list, up to the closing paren of the call.
        const from = match.index + match[0].length;
        const end = src.indexOf(")", from);
        calls.push(src.slice(from, end));
      }
      if (calls.length) found.set(rel, calls);
    }
  }
  return found;
}

/**
 * The inventory. Every surface on this deployment that accepts an API token,
 * with the capability it demands - and why that one and not a wider one.
 */
const EXPECTED: Record<string, readonly string[]> = {
  // POST /upload: the ShareX endpoint. Three entry points for one credential
  // (header, legacy field before the file, legacy field after it) and all three
  // ask for `upload`, so a .sxcu can never do more than post files.
  "lib/upload/sharex.ts": ["upload", "upload", "upload"],
  // The tus creation request. Same capability as the single-POST path, because
  // it is the same act over a different transport.
  "lib/upload/tus.ts": ["upload"],
  // Seeing an unpublished or password-stamped file, and being exempt from its
  // view budget. That is reading a library.
  "lib/media/serve.ts": ["read"],
  // /{tag}/{code}/delete/{token} also accepts an ACCOUNT token in the slot the
  // per-file delete token normally fills, and that one deletes for good.
  "app/[userCode]/[mediaCode]/delete/[token]/route.ts": ["write"],
  "app/api/uploads/route.ts": ["read", "write", "write"], // GET, PATCH, DELETE
  "app/api/uploads/check/route.ts": ["read"],
  // Finding duplicate sets is reading the library; waving one off (or counting
  // it again) changes what the account will be told in future, so it is a
  // write - even though it touches no bytes of anybody's files. Removing the
  // copies is not here at all: that is DELETE /api/uploads.
  "app/api/duplicates/route.ts": ["read", "write"], // GET, POST
  "app/api/folders/route.ts": ["read", "write", "write", "write"], // GET, POST, PATCH, DELETE
  "app/api/shortlinks/route.ts": ["read", "write"], // GET, POST
  "app/api/client-settings/route.ts": ["read", "write"], // GET, PUT
  "app/api/theme/route.ts": ["read", "write"], // GET, PUT
  // Any valid token, deliberately: this is how a client checks its own config.
  "app/api/me/route.ts": ["identify"],
  // Publishing a build to every installation. The scope AND the account role.
  "app/api/releases/app/route.ts": ["admin"],
  // What the whole install is storing, account by account. Same pair of gates
  // as publishing a release, for the same reason: the role says who may read
  // it, the scope says which credential may - so an administrator's ordinary
  // desktop token does not carry the server's file listing around in a config
  // file.
  "app/api/admin/disk/route.ts": ["admin"],
  // Anonymous by design; a token that cannot read simply describes links as a
  // stranger would.
  "app/api/link-info/route.ts": ["read"],
};

describe("every surface that accepts an API token names a capability", () => {
  const found = surfaces();

  it("has no call site that resolves a caller without saying what it needs", () => {
    const unscoped: string[] = [];
    for (const [file, calls] of found) {
      if (FORWARDERS.has(file)) continue;
      for (const args of calls) {
        if (!CAPABILITY.test(args)) unscoped.push(`${file}: (${args.trim()})`);
      }
    }
    expect(unscoped).toEqual([]);
  });

  it("matches the inventory, so a new token surface cannot appear unnoticed", () => {
    const actual = [...found.keys()].filter((f) => !FORWARDERS.has(f)).sort();
    // A file added here without a line in EXPECTED fails; a file removed from
    // the tree while EXPECTED still lists it fails too. Either way somebody
    // looks at the capability before the change lands.
    expect(actual).toEqual(Object.keys(EXPECTED).sort());
  });

  it("demands the capability the inventory says it does", () => {
    for (const [file, expectedCaps] of Object.entries(EXPECTED)) {
      const calls = found.get(file);
      expect(calls, `${file} no longer resolves an API-token caller`).toBeDefined();
      const caps = calls!.map((args) => CAPABILITY.exec(args)?.[1]);
      expect(caps, file).toEqual([...expectedCaps]);
    }
  });
});
