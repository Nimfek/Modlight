import { DEFAULT_THEME, THEMES, THEME_ALIASES, THEME_IDS, isThemeId, type ThemeId } from "@/lib/themes";

/**
 * The wire contract for GET/PUT /api/theme.
 *
 * The desktop client owns the same setting the panel's picker owns, so both ends
 * have to agree on what a valid skin id is and on what a refusal looks like.
 * Pure: no db, no next/*, no framework, so the route handler and the tests read
 * the same rules instead of one re-deriving them from the other.
 */

/**
 * Ceiling on the request body.
 *
 * The only field is a skin id of at most a dozen characters, so 4 KiB is already
 * absurdly generous - and without a ceiling `req.text()` buffers whatever
 * arrives into memory before there is anything to validate. Same reasoning as
 * the short-link body cap in app/api/shortlinks/route.ts.
 */
export const THEME_BODY_MAX_BYTES = 4 * 1024;

/**
 * One entry of the picker a client renders.
 *
 * `name`/`description` are the ENGLISH FALLBACKS from lib/themes.ts. The panel
 * translates them through `profile.themes.<id>.{name,desc}` and a client is free
 * to do the same keyed on `id`; shipping the English text anyway means a client
 * that has no dictionary for a skin added after its release still shows
 * something a human can read, rather than a raw id.
 */
export interface ThemeChoice {
  id: ThemeId;
  name: string;
  description: string;
}

/**
 * Every skin, in picker order.
 *
 * Served on every GET so a client never hardcodes the list. That is the whole
 * point: this deployment has gained six skins in one round already, and a
 * hardcoded copy in a shipped desktop binary goes stale the moment the server is
 * updated - which shows up as a skin the website uses and the app cannot name.
 */
export function themeCatalog(): ThemeChoice[] {
  return THEMES.map((t) => ({ id: t.id, name: t.name, description: t.description }));
}

/** Refusal for a skin id we do not have, listing the ones we do. */
export function unknownThemeMessage(): string {
  return `Unknown theme. Known themes: ${THEME_IDS.join(", ")}.`;
}

export type ThemeBody =
  | { ok: true; theme: ThemeId }
  | { ok: false; status: 400 | 413; message: string };

/**
 * Validate a PUT body: `{"theme": "<id>"}`.
 *
 * Error-as-data rather than thrown strings, like the rest of the server side:
 * the caller needs the status code as much as the sentence.
 *
 * The important line is the last one, and it is a REFUSAL rather than a
 * normalisation. `resolveTheme` - the function every read path uses - maps
 * anything it does not recognise onto the default, which is exactly right when
 * painting a page from a column that may hold a value written years ago, and
 * exactly wrong here: it would accept `{"theme": "hunter2"}` with a 200 and
 * silently store `default`, so a client with a typo in its picker would report
 * success while resetting the user's skin on every save. Validation therefore
 * goes through `isThemeId`, which knows the difference between "a skin" and
 * "not a skin".
 *
 * A RETIRED id is accepted and canonicalised, because THEME_ALIASES is a promise
 * that a renamed skin keeps working forever and this endpoint is not the one
 * place that breaks it. `modern` is not a guess, it is what thousands of rows in
 * production still literally contain; it means `default` and is stored as such.
 * Membership of the alias map is checked explicitly - not by calling
 * `resolveTheme` and seeing what falls out - so garbage stays garbage.
 */
export function parseThemeBody(text: string): ThemeBody {
  if (text.trim() === "") {
    return { ok: false, status: 400, message: 'Body must be JSON: {"theme": "<id>"}.' };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Also where absurdly nested input lands: V8 raises a RangeError out of
    // JSON.parse, and an uncaught one would be a 500 describing our stack
    // instead of a 400 describing their body.
    return { ok: false, status: 400, message: "Body is not valid JSON." };
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, message: 'Body must be a JSON object: {"theme": "<id>"}.' };
  }

  const raw = (body as Record<string, unknown>).theme;
  if (typeof raw !== "string") {
    return { ok: false, status: 400, message: "`theme` is required and must be a string." };
  }

  const value = raw.trim();
  if (isThemeId(value)) return { ok: true, theme: value };

  const alias = Object.prototype.hasOwnProperty.call(THEME_ALIASES, value)
    ? THEME_ALIASES[value]
    : undefined;
  if (alias) return { ok: true, theme: alias };

  return { ok: false, status: 400, message: unknownThemeMessage() };
}

/** Re-exported so the route and its tests name the fallback from one place. */
export { DEFAULT_THEME };
