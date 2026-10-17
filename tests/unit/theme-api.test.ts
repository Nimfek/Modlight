import { describe, it, expect } from "vitest";
import {
  DEFAULT_THEME,
  parseThemeBody,
  themeCatalog,
  unknownThemeMessage,
} from "@/lib/theme-api";
import { THEMES, THEME_ALIASES, THEME_IDS, isThemeId } from "@/lib/themes";

/**
 * The contract GET/PUT /api/theme is: what a client may be told, and what it may
 * be allowed to store.
 *
 * The setting is shared between two programs now - the panel's picker and the
 * desktop client - so the interesting cases are the ones where the two could
 * disagree about what a skin id is.
 */

describe("theme catalogue", () => {
  it("offers every skin the panel offers, in the same order", () => {
    // A client renders its picker from this. If it drifted from THEMES, the app
    // would offer skins the server refuses, or hide ones the website uses.
    expect(themeCatalog().map((t) => t.id)).toEqual(THEMES.map((t) => t.id));
  });

  it("carries readable text for a skin the client has never heard of", () => {
    // A desktop binary ships with a dictionary frozen at release time; this
    // deployment gained six skins in one round. The English fallback is what
    // keeps a newly added skin from rendering as a bare id.
    for (const choice of themeCatalog()) {
      expect(choice.name.length).toBeGreaterThan(0);
      expect(choice.description.length).toBeGreaterThan(0);
    }
  });

  it("names a default that is itself a valid choice", () => {
    expect(isThemeId(DEFAULT_THEME)).toBe(true);
    expect(themeCatalog().some((t) => t.id === DEFAULT_THEME)).toBe(true);
  });
});

describe("parseThemeBody", () => {
  it("accepts every id the catalogue advertises", () => {
    // The round trip a client actually makes: read the list, send one back.
    for (const id of THEME_IDS) {
      expect(parseThemeBody(JSON.stringify({ theme: id }))).toEqual({ ok: true, theme: id });
    }
  });

  it("refuses an unknown id instead of storing the default", () => {
    // The trap this endpoint exists to avoid. `resolveTheme` - what every READ
    // path uses - maps anything unrecognised onto the default, so validating
    // with it would answer 200 to a typo and silently reset the user's skin on
    // every save. Only isThemeId knows the difference.
    const res = parseThemeBody(JSON.stringify({ theme: "hunter2" }));
    expect(res).toEqual({ ok: false, status: 400, message: unknownThemeMessage() });
    expect(res.ok).toBe(false);
  });

  it("names the ids it would have accepted", () => {
    // A client that hardcoded a stale list should be able to see what changed
    // from the refusal alone, without a second round trip.
    for (const id of THEME_IDS) expect(unknownThemeMessage()).toContain(id);
  });

  it("accepts a retired id and stores the name it was renamed to", () => {
    // THEME_ALIASES is a standing promise that a renamed skin keeps working, and
    // "modern" is not hypothetical: it is the column default and what thousands
    // of production rows literally contain. This endpoint is not the one place
    // the promise breaks.
    for (const [retired, current] of Object.entries(THEME_ALIASES)) {
      expect(parseThemeBody(JSON.stringify({ theme: retired }))).toEqual({
        ok: true,
        theme: current,
      });
    }
  });

  it("does not treat inherited object properties as aliases", () => {
    // The alias lookup is a plain object, so "constructor" and "toString" are
    // truthy on it. Read carelessly, those would be accepted as skin ids and
    // whatever they resolved to would be written to the row.
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(parseThemeBody(JSON.stringify({ theme: key }))).toMatchObject({ ok: false });
    }
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseThemeBody(JSON.stringify({ theme: "  terminal " }))).toEqual({
      ok: true,
      theme: "terminal",
    });
  });

  it("refuses a `theme` that is not a string", () => {
    // Coercing would be worse than refusing: `{"theme": 0}` is a client bug, and
    // "0" is not a skin either way.
    for (const value of [0, 1, true, null, {}, ["terminal"]]) {
      expect(parseThemeBody(JSON.stringify({ theme: value }))).toMatchObject({
        ok: false,
        status: 400,
      });
    }
  });

  it("refuses a body that is not a JSON object", () => {
    for (const raw of ['"terminal"', "[]", "null", "42", '["terminal"]']) {
      expect(parseThemeBody(raw)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("refuses an empty or unparseable body with a 400, not a crash", () => {
    // A 500 here would hand a desktop client an HTML error page it cannot read,
    // in place of a sentence saying what was wrong with its request.
    for (const raw of ["", "   ", "{", "{theme: terminal}"]) {
      expect(parseThemeBody(raw)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("ignores anything else in the envelope", () => {
    // A client syncing several settings at once should not be refused for
    // sending a field this endpoint does not own.
    expect(parseThemeBody(JSON.stringify({ theme: "paper", locale: "pl" }))).toEqual({
      ok: true,
      theme: "paper",
    });
  });
});
