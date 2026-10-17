import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "app/actions/releases.ts"), "utf8");

/**
 * A Server Action is a public endpoint with a nicer calling convention, so the
 * only thing standing between a stranger and the release channel is the admin
 * check inside each one. A hidden button proves nothing.
 */
describe("release actions", () => {
  for (const fn of ["loadRelease", "publishAppRelease", "unpublishAppRelease"]) {
    it(`${fn} checks admin before doing anything`, () => {
      const at = source.indexOf(`export async function ${fn}`);
      expect(at, `${fn} not found`).toBeGreaterThan(-1);
      // Sliced to the NEXT exported function rather than to the first
      // newline-brace: these signatures span several lines and end with
      // `}): Promise<...> {`, so the naive cut landed before the body began
      // and the assertion was measuring the signature, not the guard.
      const after = source.indexOf("export async function", at + 1);
      const body = source.slice(at, after === -1 ? source.length : after);
      expect(body).toContain("await requireAdmin()");
      // Before the work, not after: an admin check that runs second is a check
      // that lets the work happen.
      const guard = body.indexOf("await requireAdmin()");
      const work = Math.min(
        ...["publishRelease(", "unpublishRelease(", "currentRelease("]
          .map((needle) => body.indexOf(needle))
          .filter((i) => i > -1),
      );
      expect(guard).toBeLessThan(work);
    });
  }
});

/**
 * Somebody publishing a release has the file's LINK on their clipboard, not its
 * bare code. Making them edit it by hand is how a step gets skipped.
 */
describe("what counts as a code", () => {
  // The helper is module-private, so its behaviour is asserted through the
  // shapes it must accept — spelled out here so a rewrite cannot quietly drop
  // one of them.
  const cases: Array<[string, string]> = [
    ["abcde12345", "abcde12345"],
    ["https://host.example.com/alicja/abcde12345.exe", "abcde12345"],
    ["https://host.example.com/alicja/abcde12345", "abcde12345"],
    ["  https://h.example.com/alicja/abcde12345.exe?x=1  ", "abcde12345"],
  ];

  for (const [input, expected] of cases) {
    it(`reads ${JSON.stringify(input)} as ${expected}`, () => {
      const trimmed = input.trim();
      const withoutQuery = trimmed.split(/[?#]/)[0];
      const segment = withoutQuery.split("/").filter(Boolean).pop() ?? "";
      const dot = segment.indexOf(".");
      expect(dot > 0 ? segment.slice(0, dot) : segment).toBe(expected);
    });
  }

  it("keeps the same parsing rule as the action", () => {
    // If the action's implementation changes shape, this test must be revisited
    // rather than silently testing a copy that no longer matches.
    expect(source).toContain("const withoutQuery = trimmed.split(/[?#]/)[0]");
    expect(source).toContain('const segment = withoutQuery.split("/").filter(Boolean).pop() ?? ""');
  });
});
