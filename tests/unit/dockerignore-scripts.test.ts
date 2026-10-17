import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every script `build:server` compiles must survive `.dockerignore`.
 *
 * `.dockerignore` excludes `scripts/` wholesale and re-admits files one by one.
 * esbuild then resolves the entry points from the build CONTEXT, so a script that
 * was never re-admitted does not fail locally - it fails inside the image, with
 * "Could not resolve", after everything here was green. That happened twice: with
 * the release publisher, and again on 28.09.2026 with the video backfill. The old
 * image kept serving, so the deploy looked fine and shipped nothing.
 */
describe(".dockerignore keeps every script build:server needs", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const buildServer: string = pkg.scripts["build:server"];
  const ignore = readFileSync(join(process.cwd(), ".dockerignore"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim());

  // Entry points esbuild compiles, plus anything the script runs afterwards.
  const needed = [...buildServer.matchAll(/\.\/(scripts\/[\w.-]+\.(?:ts|mjs))/g)].map((m) => m[1]);

  it("finds the scripts it is supposed to check", () => {
    expect(needed.length).toBeGreaterThan(2);
  });

  it.each(needed)("re-admits %s", (script) => {
    expect(ignore).toContain(`!${script}`);
  });
});
