import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { En } from "media-chrome/dist/lang/en.js";
import {
  PLAYER_LABELS,
  PLAYER_LABEL_VARS,
  buildPlayerDictionary,
  playerLang,
  type PlayerLabelId,
} from "@/lib/media/player-i18n";

function messages(locale: "en" | "pl"): Record<string, unknown> {
  const raw = readFileSync(join(process.cwd(), "messages", locale, "viewer.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

/** `player.tooltip.play` out of the nested dictionary, or undefined. */
function lookup(dict: Record<string, unknown>, path: string): string | undefined {
  let node: unknown = dict;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

const ids = Object.keys(PLAYER_LABELS) as PlayerLabelId[];

describe("player labels are wired to the strings media-chrome actually asks for", () => {
  it("maps only keys the library still ships", () => {
    // The library keys its dictionary by the English sentence, so a reworded
    // label upstream silently drops one control back to English on a Polish
    // page. This is the tripwire for that.
    const unknown = Object.values(PLAYER_LABELS).filter((key) => !(key in En));
    expect(unknown).toEqual([]);
  });

  it("never maps two of our ids onto the same library key", () => {
    const keys = Object.values(PLAYER_LABELS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers every control the player renders", () => {
    // A spot check that the table did not lose an entry: these are the labels
    // a visitor reads or hears on the controls we mount.
    for (const key of ["Play", "Pause", "Mute", "Playback rate", "seek", "volume"]) {
      expect(Object.values(PLAYER_LABELS)).toContain(key);
    }
  });
});

describe("both dictionaries carry every player label", () => {
  const en = messages("en");
  const pl = messages("pl");

  it.each(ids)("%s is translated in en and pl", (id) => {
    expect(lookup(en, `player.${id}`), `en player.${id}`).toBeTypeOf("string");
    expect(lookup(pl, `player.${id}`), `pl player.${id}`).toBeTypeOf("string");
  });

  it("keeps the runtime placeholders the library substitutes later", () => {
    // "cofnij o sekund" instead of "cofnij o {seekOffset} sekund" is a broken
    // aria label, and nothing else in the app would catch it.
    for (const [id, names] of Object.entries(PLAYER_LABEL_VARS) as [
      PlayerLabelId,
      readonly string[],
    ][]) {
      for (const locale of [en, pl]) {
        const text = lookup(locale, `player.${id}`) ?? "";
        for (const name of names) {
          expect(text, `${id} / ${name}`).toContain(`{${name}}`);
        }
      }
    }
  });
});

describe("buildPlayerDictionary", () => {
  it("returns a dictionary keyed the way the library looks strings up", () => {
    const dictionary = buildPlayerDictionary((id) => `<${id}>`);
    expect(dictionary["Play"]).toBe("<tooltip.play>");
    expect(dictionary["seek"]).toBe("<aria.seek>");
    expect(Object.keys(dictionary)).toHaveLength(ids.length);
  });

  it("hands each placeholder back to the translator as its own value", () => {
    // next-intl would refuse a message with an argument nobody supplied, so the
    // placeholder is passed in and comes back out untouched for media-chrome.
    const seen: Record<string, Record<string, string> | undefined> = {};
    buildPlayerDictionary((id, values) => {
      seen[id] = values;
      return values ? Object.values(values).join("|") : id;
    });
    expect(seen["aria.timeOf"]).toEqual({
      currentTime: "{currentTime}",
      totalTime: "{totalTime}",
    });
    expect(seen["aria.seekBackward"]).toEqual({ seekOffset: "{seekOffset}" });
    expect(seen["tooltip.play"]).toBeUndefined();
  });
});

describe("playerLang", () => {
  it("resolves the base language, because pl-PL must find the pl dictionary", () => {
    expect(playerLang("pl")).toBe("pl");
    expect(playerLang("pl-PL")).toBe("pl");
    expect(playerLang("PL")).toBe("pl");
  });

  it("falls back to English for everything we do not translate", () => {
    expect(playerLang("en-GB")).toBe("en");
    expect(playerLang("de")).toBe("en");
    expect(playerLang(null)).toBe("en");
    expect(playerLang(undefined)).toBe("en");
    expect(playerLang("")).toBe("en");
  });
});
