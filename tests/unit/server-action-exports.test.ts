import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A "use server" module may only export things that survive to runtime.
 *
 * Next registers EVERY export of such a module as a server action. A type
 * re-export of a locally imported binding does not survive type erasure, so the
 * emitted module references a name that does not exist and throws
 * `ReferenceError` the moment anything imports it - which, for a "use server"
 * file, means every server action in the app stops working at once.
 *
 * This actually happened: `export type { DeleteFolderResult };` in
 * app/actions/folders.ts took out deleting files, revoking tokens and everything
 * else in the panel, in production, while `tsc --noEmit` stayed clean because it
 * knows perfectly well that the name is a type.
 *
 * `export type { X } from "./y"` is FINE - the `from` clause makes it a
 * standalone type-only re-export with nothing local to erase. What is banned is
 * the two-step form: import the type, then export the local name.
 */

const dir = join(process.cwd(), "app/actions");
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

describe("server action modules export nothing that vanishes at runtime", () => {
  it("finds the action modules at all", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    const source = readFileSync(join(dir, file), "utf8");
    if (!/^["']use server["']/m.test(source)) continue;

    it(`${file} re-exports no locally imported type`, () => {
      // `export type { ... }` with no `from` on the same statement.
      const offenders: string[] = [];
      const pattern = /export\s+type\s*\{[^}]*\}\s*(?:from\s*["'][^"']+["'])?\s*;/g;
      for (const match of source.matchAll(pattern)) {
        if (!/from\s*["']/.test(match[0])) offenders.push(match[0].replace(/\s+/g, " "));
      }
      expect(offenders, `${file}: ${offenders.join(" | ")}`).toEqual([]);
    });
  }
});
