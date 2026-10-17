import { describe, it, expect } from "vitest";
import {
  allocateCode,
  buildCodeBase,
  clampRandomLength,
  clampWordCount,
  expandPattern,
  isGuessable,
  isNamingScheme,
  NAMING_SCHEMES,
  planCode,
  randomCharCode,
  wordCode,
} from "@/lib/naming";
import { ADJECTIVES, NOUNS, UNAMBIGUOUS_ALPHABET, poolSize } from "@/lib/naming-words";

/**
 * The characters the user explicitly asked us to keep out of codes: they are
 * the pairs people mistype when copying a link off a screen or repeating it
 * over the phone.
 */
const CONFUSABLE = /[0Oo1lI]/;

describe("UNAMBIGUOUS_ALPHABET", () => {
  it("contains no look-alike characters", () => {
    expect(UNAMBIGUOUS_ALPHABET).not.toMatch(CONFUSABLE);
  });

  it("has no duplicates", () => {
    expect(new Set(UNAMBIGUOUS_ALPHABET).size).toBe(UNAMBIGUOUS_ALPHABET.length);
  });
});

describe("randomCharCode", () => {
  it("never emits a confusable character", () => {
    // 400 codes x 12 chars is ~5k draws — every alphabet slot gets hit many
    // times over, so a stray 0/O/l/I could not survive this unnoticed.
    for (let i = 0; i < 400; i++) {
      expect(randomCharCode(12)).not.toMatch(CONFUSABLE);
    }
  });

  it("honours the requested length", () => {
    for (const n of [5, 6, 8, 12, 32]) {
      expect(randomCharCode(n)).toHaveLength(n);
    }
  });

  it("draws from the whole alphabet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) for (const ch of randomCharCode(8)) seen.add(ch);
    // Every character produced must be a member; near-full coverage proves the
    // index isn't clamped to a prefix of the alphabet.
    for (const ch of seen) expect(UNAMBIGUOUS_ALPHABET).toContain(ch);
    expect(seen.size).toBeGreaterThan(UNAMBIGUOUS_ALPHABET.length - 3);
  });
});

describe("wordCode", () => {
  it("produces the requested number of words", () => {
    for (const n of [2, 3, 4]) {
      const parts = wordCode(n).split("-");
      expect(parts, `${n} words`).toHaveLength(n);
    }
  });

  it("always ends with a noun and leads with adjectives", () => {
    for (let i = 0; i < 200; i++) {
      const parts = wordCode(3).split("-");
      expect(NOUNS).toContain(parts[parts.length - 1]);
      for (const adjective of parts.slice(0, -1)) expect(ADJECTIVES).toContain(adjective);
    }
  });

  it("never repeats an adjective within one code", () => {
    for (let i = 0; i < 200; i++) {
      const adjectives = wordCode(4).split("-").slice(0, -1);
      expect(new Set(adjectives).size).toBe(adjectives.length);
    }
  });

  it("reads like Gyazo: lowercase words joined by dashes", () => {
    expect(wordCode(2)).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("clamps counts outside 2–4 instead of throwing", () => {
    expect(wordCode(1).split("-")).toHaveLength(2);
    expect(wordCode(99).split("-")).toHaveLength(4);
  });
});

describe("clamps", () => {
  it("keeps random codes at 5 characters or more", () => {
    // The user picked 5 as the floor; anything shorter is walkable.
    expect(clampRandomLength(1)).toBe(5);
    expect(clampRandomLength(0)).toBe(5);
    expect(clampRandomLength(-3)).toBe(5);
    expect(clampRandomLength(null)).toBe(6);
    expect(clampRandomLength(999)).toBe(32);
    expect(clampRandomLength(7)).toBe(7);
  });

  it("keeps word counts within 2–4", () => {
    expect(clampWordCount(0)).toBe(2);
    expect(clampWordCount(null)).toBe(2);
    expect(clampWordCount(9)).toBe(4);
    expect(clampWordCount(3)).toBe(3);
  });
});

describe("buildCodeBase — new schemes", () => {
  it("words produces a readable pair by default", () => {
    const code = buildCodeBase({ scheme: "words", filename: "shot.png", wordCount: 2 });
    expect(code).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("random-chars honours the stored length and stays unambiguous", () => {
    const code = buildCodeBase({ scheme: "random-chars", filename: "shot.png", randomLength: 9 });
    expect(code).toHaveLength(9);
    expect(code).not.toMatch(CONFUSABLE);
  });

  it("falls back to safe defaults when the parameters are missing", () => {
    expect(buildCodeBase({ scheme: "words", filename: "a.png" }).split("-")).toHaveLength(2);
    expect(buildCodeBase({ scheme: "random-chars", filename: "a.png" })).toHaveLength(6);
  });

  it("registers both schemes so the profile can offer them", () => {
    expect(NAMING_SCHEMES).toContain("words");
    expect(NAMING_SCHEMES).toContain("random-chars");
    expect(isNamingScheme("words")).toBe(true);
    expect(isNamingScheme("random-chars")).toBe(true);
    expect(isNamingScheme("nonsense")).toBe(false);
  });

  it("does not flag the randomised schemes as guessable", () => {
    expect(isGuessable("words")).toBe(false);
    expect(isGuessable("random-chars")).toBe(false);
  });
});

describe("expandPattern — words and rand tokens", () => {
  const now = new Date("2026-07-30T14:05:09Z");

  it("expands {words2} and {rand5} the way the user wrote the example", () => {
    const out = expandPattern("{words2}_{rand5}", "shot.png", now);
    expect(out).toMatch(/^[a-z]+-[a-z]+_.{5}$/);
    const [, chars] = out.split("_");
    expect(chars).not.toMatch(CONFUSABLE);
  });

  it("supports a sized word token", () => {
    expect(expandPattern("{words4}", "a.png", now).split("-")).toHaveLength(4);
    expect(expandPattern("{words3}", "a.png", now).split("-")).toHaveLength(3);
  });

  it("supports bare {words} and {rand}", () => {
    expect(expandPattern("{words}", "a.png", now).split("-")).toHaveLength(2);
    expect(expandPattern("{rand}", "a.png", now)).toHaveLength(6);
  });

  it("keeps the pre-existing tokens working", () => {
    expect(expandPattern("{year}-{month}-{day}", "a.png", now)).toBe("2026-07-30");
    expect(expandPattern("{name}.{ext}", "Raport Roczny.pdf", now)).toBe("raport-roczny.pdf");
    expect(expandPattern("{random:3}", "a.png", now)).toMatch(/^[a-z0-9]{3}$/);
  });

  it("leaves unknown tokens alone", () => {
    expect(expandPattern("{nope}-{name}", "a.png", now)).toBe("{nope}-a");
  });
});

describe("buildCodeBase — custom patterns keep their shape", () => {
  const now = new Date("2026-07-30T14:05:09Z");

  it("preserves case and underscores, unlike the slug-only path", () => {
    // The user's own example: {words2}_{rand5} -> funky-otter_fJ4as
    const code = buildCodeBase({
      scheme: "custom",
      pattern: "{words2}_{rand5}",
      filename: "shot.png",
      now,
    });
    expect(code).toMatch(/^[a-z]+-[a-z]+_[A-Za-z2-9]{5}$/);
    expect(code).toContain("_");
  });

  it("still collapses path-unsafe characters", () => {
    const code = buildCodeBase({
      scheme: "custom",
      pattern: "{year}/{month}-{name}",
      filename: "Raport Roczny.pdf",
      now,
    });
    expect(code).toBe("2026-07-raport-roczny");
  });
});

describe("allocateCode — collisions", () => {
  it("grows a random code by one character instead of appending -2", async () => {
    const plan = planCode({ scheme: "random-chars", filename: "a.png", randomLength: 5 });
    const taken = new Set([plan.base]);

    const code = await allocateCode(plan.base, async (c) => taken.has(c), plan.regenerate);

    expect(code).toHaveLength(6);
    expect(code).not.toMatch(/-\d+$/);
    expect(code).not.toMatch(CONFUSABLE);
  });

  it("keeps widening while the namespace stays saturated", async () => {
    const plan = planCode({ scheme: "random-chars", filename: "a.png", randomLength: 5 });
    // Refuse everything shorter than 8 characters: the ladder has to reach it.
    const code = await allocateCode(plan.base, async (c) => c.length < 8, plan.regenerate);
    expect(code).toHaveLength(8);
  });

  it("re-rolls words before adding one, then adds one", async () => {
    const plan = planCode({ scheme: "words", filename: "a.png", wordCount: 2 });
    // Only three-word codes are free, so the generator must escalate.
    const code = await allocateCode(
      plan.base,
      async (c) => c.split("-").length < 3,
      plan.regenerate,
    );
    expect(code.split("-").length).toBeGreaterThanOrEqual(3);
    expect(code).not.toMatch(/-\d+$/);
  });

  it("leaves name-derived schemes on the numeric ladder", async () => {
    // planCode returns no regenerator for these, so `-2` remains correct: it
    // reads as "the second file with that name".
    const plan = planCode({ scheme: "filename", filename: "raport.pdf" });
    expect(plan.regenerate).toBeUndefined();

    const taken = new Set(["raport"]);
    const code = await allocateCode(plan.base, async (c) => taken.has(c), plan.regenerate);
    expect(code).toBe("raport-2");
  });

  it("gives up rather than looping forever when nothing is free", async () => {
    const plan = planCode({ scheme: "random-chars", filename: "a.png", randomLength: 5 });
    await expect(allocateCode(plan.base, async () => true, plan.regenerate)).rejects.toThrow(
      /unique code/,
    );
  });
});

describe("pool sizes shown in the profile", () => {
  it("matches the documented ~550 million at five characters", () => {
    expect(poolSize(5)).toBe(56 ** 5);
    expect(poolSize(5)).toBeGreaterThan(500_000_000);
  });

  it("grows 56x per extra character, which is why widening works", () => {
    expect(poolSize(6) / poolSize(5)).toBe(56);
  });
});
