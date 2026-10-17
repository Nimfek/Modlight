import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Two wiring invariants that no gate used to hold, and that a parallel build is
 * exactly the situation to lose.
 *
 * A screen can be complete - route, data, actions, translations, tests - and
 * still be finished work nobody can reach, because the file that links to it
 * belongs to a different part of the tree than the file that renders it. That
 * happened to /dashboard/duplicates: page, components and dictionary keys all
 * landed, the sidebar entry did not, and every automated check stayed green
 * because an unreachable page compiles exactly like a reachable one.
 *
 * The same shape of gap applies to `relativeTime`: the moment it grew a locale
 * argument, every call site that did not pass one became a Polish page printing
 * English ages, with types, tests and build entirely satisfied.
 */

const ROOT = process.cwd();
const SHELL = join(ROOT, "components", "app-shell.tsx");
const PANEL = join(ROOT, "app", "(app)", "dashboard");

/** Top-level panel screens: a directory with its own page. Dynamic segments are
 *  reached from a row or a card, never from the rail, so they are out of scope. */
function panelScreens(): string[] {
  return readdirSync(PANEL).filter((name) => {
    if (name.startsWith("[")) return false;
    const dir = join(PANEL, name);
    return statSync(dir).isDirectory() && existsSync(join(dir, "page.tsx"));
  });
}

describe("every panel screen is reachable from the shell", () => {
  const shell = readFileSync(SHELL, "utf8");
  const screens = panelScreens();

  it("finds the screens and the shell", () => {
    expect(screens.length).toBeGreaterThan(5);
    expect(shell).toContain("nav");
  });

  for (const screen of screens) {
    it(`links to /dashboard/${screen}`, () => {
      // An `href`, specifically, in either of the two shapes the shell uses: a
      // JSX attribute or a field in one of the nav-item tables. Matching the
      // bare path would also be satisfied by the `pathname.startsWith(...)`
      // that decides which row is the ACTIVE one, so a rail that highlights a
      // screen it no longer links to would still read as reachable.
      const attribute = `href="/dashboard/${screen}"`;
      const field = `href: "/dashboard/${screen}"`;
      expect(shell.includes(attribute) || shell.includes(field), attribute).toBe(true);
    });

    it(`names /dashboard/${screen} in the mobile header`, () => {
      // TITLE_ROUTES is the only thing that says where you are on a phone, and
      // its last entry matches everything under /dashboard - so a screen left
      // out of it does not go blank, it silently claims to be the file list.
      expect(shell).toContain(`prefix: "/dashboard/${screen}"`);
    });
  }
});

describe("relativeTime is always told the reader's language", () => {
  /** Every .ts/.tsx under app/ and components/. */
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) sources(p, out);
      else if (/\.tsx?$/.test(entry)) out.push(p);
    }
    return out;
  }

  it("has no call that leaves the locale to the default", () => {
    const offenders: string[] = [];
    for (const file of [...sources(join(ROOT, "app")), ...sources(join(ROOT, "components"))]) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("relativeTime(")) continue;
      for (const [i, line] of src.split("\n").entries()) {
        // The import line names it without calling it.
        if (!/relativeTime\(/.test(line) || /from "@\/lib\/format"/.test(line)) continue;
        // A locale is the second argument, so the call has to carry a comma at
        // its own bracket depth. Counting is enough here: these are one-line
        // calls, and a nested `relativeTime(new Date(x), locale)` still ends in
        // `, locale)`.
        if (!/relativeTime\([^)]*(?:\([^)]*\))?[^)]*,\s*\w+\s*\)/.test(line)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
