import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Plain hyphens in anything a visitor can read: no em dash and no en dash.
 *
 * Translations are the entire user-facing surface, so they are checked
 * exhaustively rather than by review — a style rule nobody enforces survives
 * about three edits. Code comments are deliberately out of scope: they are not
 * "on the site".
 */
const EM = "—";
const EN = "–";

function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...jsonFiles(p));
    else if (entry.endsWith(".json")) out.push(p);
  }
  return out;
}

describe("user-facing copy uses plain hyphens", () => {
  const files = jsonFiles(join(process.cwd(), "messages"));

  it("finds the translation dictionaries", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const label = file.split(/[\\/]/).slice(-2).join("/");
    it(`has no long dash: ${label}`, () => {
      const offenders = readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => line.includes(EM) || line.includes(EN))
        .map(({ line, n }) => `${n}: ${line.trim()}`);
      expect(offenders).toEqual([]);
    });
  }

  it("the page title template uses a hyphen", () => {
    const layout = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");
    const template = layout.split("\n").find((l) => l.includes("template:")) ?? "";
    expect(template).not.toContain(EM);
    expect(template).not.toContain(EN);
  });
});
