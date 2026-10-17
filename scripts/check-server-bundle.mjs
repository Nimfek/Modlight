/**
 * Fail the build when the custom-server bundle imports something that will not
 * exist at runtime.
 *
 * This exists because of a real near miss: a shared module picked up
 * `import "server-only"`, which is not an installed package at all — it resolves
 * only inside Next's bundler (which aliases it) and inside vitest (which stubs
 * it). `build:server` is plain esbuild with `--packages=external`, so the bare
 * specifier passed straight through into dist/server.js, and `node dist/server.js`
 * would have died at link time with ERR_MODULE_NOT_FOUND — before server.listen(),
 * i.e. a crash loop taking down uploads, the panel and every media link.
 *
 * The reason it needs its own check is that NONE of the three gates can see it:
 *   - `tsc` passes, because Next ships `declare module "server-only"` in its types;
 *   - `vitest` passes, because vitest.config.ts aliases the specifier to a stub;
 *   - `next build` passes, because it never compiles server.ts.
 * Only actually starting the process fails, and that is not part of the build.
 *
 * So: resolve every external specifier the bundle imports, from the bundle's own
 * directory, exactly as Node will. Anything that does not resolve is a build
 * failure with the offending name printed.
 */
import { createRequire } from "node:module";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, "..", "dist");

/**
 * Every bundle in dist, found by walking rather than listed by hand.
 *
 * esbuild mirrors the entry points' directory structure, so the script entries
 * land in dist/scripts/ and not next to server.js. A hardcoded list got that
 * wrong on the first attempt and skipped two bundles in silence — which is the
 * same failure mode this whole file exists to prevent.
 */
function bundles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...bundles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * Specifiers of top-level `import`/`export ... from`/`require()` in a bundle.
 * esbuild emits these on their own lines with double quotes, so a line-oriented
 * scan is enough and avoids pulling in a parser.
 */
function specifiers(code) {
  const found = new Set();
  const patterns = [
    /^\s*import\s+"([^"]+)";/gm, // side-effect import — the one that bit us
    /^\s*import\s+[^"']*?\s+from\s*"([^"]+)";/gm,
    /^\s*export\s+[^"']*?\s+from\s*"([^"]+)";/gm,
    /\brequire\("([^"]+)"\)/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) found.add(m[1]);
  }
  return found;
}

/** Node builtins never need resolving. */
function isBuiltin(name) {
  return name.startsWith("node:");
}

/** Relative specifiers point inside dist and are esbuild's own business. */
function isRelative(name) {
  return name.startsWith(".") || name.startsWith("/");
}

const problems = [];
const files = bundles(distDir);
let checked = 0;

if (files.length === 0) {
  console.error("No bundles found in dist/ — did build:server run?");
  process.exit(1);
}

for (const path of files) {
  // Resolve FROM the bundle, so the answer is the one Node will give it.
  const req = createRequire(pathToFileURL(path));
  const name = relative(distDir, path).replace(/\\/g, "/");

  for (const spec of specifiers(readFileSync(path, "utf8"))) {
    if (isBuiltin(spec) || isRelative(spec)) continue;
    checked++;
    try {
      req.resolve(spec);
    } catch {
      problems.push(`${name}: cannot resolve "${spec}"`);
    }
  }
}

if (problems.length > 0) {
  console.error("\nThe server bundle imports packages that do not exist at runtime:\n");
  for (const p of problems) console.error("  " + p);
  console.error(
    "\nThis would crash `node dist/server.js` at startup, before the server listens.\n" +
      "If the culprit is `server-only`: that guard cannot be used in any module\n" +
      "reachable from server.ts. See the note in lib/maintenance/trash.ts.\n",
  );
  process.exit(1);
}

console.log(`server bundle ok — ${checked} external import(s) resolve`);
