import { describe, it, expect } from "vitest";
import {
  slugifyName,
  baseName,
  checkTag,
  buildCodeBase,
  allocateCode,
  expandPattern,
  isGuessable,
} from "@/lib/naming";

describe("slugifyName", () => {
  it("transliterates Polish diacritics instead of dropping them", () => {
    expect(slugifyName("Źródła wiedzy")).toBe("zrodla-wiedzy");
    expect(slugifyName("Major Suchodolski to robot borzy - PRZERÓBKA")).toBe(
      "major-suchodolski-to-robot-borzy-przerobka",
    );
    expect(slugifyName("Zarządzanie projektami informatycznymi")).toBe(
      "zarzadzanie-projektami-informatycznymi",
    );
    expect(slugifyName("moment michała")).toBe("moment-michala");
  });

  it("keeps ł, which does not decompose under NFD", () => {
    // Naive NFD-only slugifiers turn this into "otego".
    expect(slugifyName("łotego")).toBe("lotego");
    expect(slugifyName("UTOPIASZ - Małpy")).toBe("utopiasz-malpy");
  });

  it("collapses punctuation and trims dashes", () => {
    expect(slugifyName("AZ-900 Exam – Free Actual Q&As, Page 1 _ ExamTopics")).toBe(
      "az-900-exam-free-actual-q-as-page-1-examtopics",
    );
    expect(slugifyName("   ...hello!!!   ")).toBe("hello");
  });

  it("handles non-Latin and empty input by returning an empty slug", () => {
    expect(slugifyName("日本語")).toBe("");
    expect(slugifyName("")).toBe("");
  });

  it("caps length so a code never becomes unbounded", () => {
    expect(slugifyName("a".repeat(300)).length).toBe(80);
  });
});

describe("baseName", () => {
  it("strips only the final extension", () => {
    expect(baseName("archive.tar.gz")).toBe("archive.tar");
    expect(baseName("Źródła wiedzy.docx")).toBe("Źródła wiedzy");
  });

  it("leaves dotfiles alone", () => {
    expect(baseName(".htaccess")).toBe(".htaccess");
  });
});

describe("checkTag", () => {
  it("accepts the legacy production tags", () => {
    // These already exist and must keep working after migration.
    for (const tag of ["alicja", "bobby", "root", "hIto3", "kiNo4", "PaLU8", "wIke5"]) {
      expect(checkTag(tag), tag).toEqual({ ok: true });
    }
  });

  it("rejects tags that would shadow an app route", () => {
    expect(checkTag("dashboard").reason).toBe("reserved");
    expect(checkTag("api").reason).toBe("reserved");
    expect(checkTag("Login").reason).toBe("reserved"); // case-insensitive
    expect(checkTag("s").reason).toBe("too-short");
  });

  it("rejects unsafe path characters", () => {
    expect(checkTag("a/b").reason).toBe("charset");
    expect(checkTag("..").reason).toBe("charset");
    expect(checkTag("a b").reason).toBe("charset");
    expect(checkTag("-lead").reason).toBe("charset");
  });

  it("enforces length bounds", () => {
    expect(checkTag("x").reason).toBe("too-short");
    expect(checkTag("x".repeat(33)).reason).toBe("too-long");
    expect(checkTag("x".repeat(32))).toEqual({ ok: true });
  });
});

describe("buildCodeBase", () => {
  const now = new Date("2026-07-30T14:05:09Z");

  it("filename scheme produces the readable URL the user asked for", () => {
    expect(
      buildCodeBase({ scheme: "filename", filename: "Źródła wiedzy.docx", now }),
    ).toBe("zrodla-wiedzy");
  });

  it("filename-random appends a suffix so codes stay unguessable", () => {
    const code = buildCodeBase({ scheme: "filename-random", filename: "raport.pdf", now });
    expect(code).toMatch(/^raport-[a-z0-9]{4}$/);
  });

  it("date-filename prefixes an ISO date", () => {
    const code = buildCodeBase({ scheme: "date-filename", filename: "raport.pdf", now });
    expect(code).toMatch(/^\d{4}-\d{2}-\d{2}-raport$/);
  });

  it("random keeps the pronounceable shape", () => {
    const code = buildCodeBase({ scheme: "random", filename: "raport.pdf", now });
    expect(code).toMatch(/^[a-zA-Z]{8}\d{2}$/);
  });

  it("falls back to a random code when the name slugifies to nothing", () => {
    const code = buildCodeBase({ scheme: "filename", filename: "日本語.png", now });
    expect(code).toMatch(/^[a-zA-Z]{8}\d{2}$/);
  });

  it("custom pattern expands tokens", () => {
    const code = buildCodeBase({
      scheme: "custom",
      pattern: "{year}/{month}-{name}",
      filename: "Raport Roczny.pdf",
      now,
    });
    expect(code).toBe("2026-07-raport-roczny");
  });
});

describe("expandPattern", () => {
  const now = new Date("2026-07-30T14:05:09Z");

  it("leaves unknown tokens untouched rather than throwing", () => {
    expect(expandPattern("{nope}-{name}", "a.png", now)).toBe("{nope}-a");
  });

  it("supports a sized random token", () => {
    expect(expandPattern("{random:3}", "a.png", now)).toMatch(/^[a-z0-9]{3}$/);
  });
});

describe("allocateCode", () => {
  it("returns the base when it is free", async () => {
    expect(await allocateCode("raport", async () => false)).toBe("raport");
  });

  it("walks a numeric ladder on collisions", async () => {
    const taken = new Set(["raport", "raport-2", "raport-3"]);
    expect(await allocateCode("raport", async (c) => taken.has(c))).toBe("raport-4");
  });

  it("falls back to a random suffix once the ladder is exhausted", async () => {
    const taken = new Set(["raport", ...Array.from({ length: 19 }, (_, i) => `raport-${i + 2}`)]);
    const code = await allocateCode("raport", async (c) => taken.has(c));
    expect(code).toMatch(/^raport-[a-z0-9]{5}$/);
  });

  it("never returns an empty code", async () => {
    expect(await allocateCode("", async () => false)).toMatch(/^[a-zA-Z]{8}\d{2}$/);
  });

  it("throws rather than looping forever when everything is taken", async () => {
    await expect(allocateCode("x", async () => true)).rejects.toThrow(/unique code/);
  });
});

describe("isGuessable", () => {
  it("flags exactly the schemes that expose predictable URLs", () => {
    expect(isGuessable("filename")).toBe(true);
    expect(isGuessable("date-filename")).toBe(true);
    expect(isGuessable("custom")).toBe(true);
    expect(isGuessable("random")).toBe(false);
    expect(isGuessable("filename-random")).toBe(false);
  });
});
