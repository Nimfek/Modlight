/**
 * The desktop client's own configuration, kept on the server.
 *
 * The owner's requirement (docs/decyzje-modlight-app.md, "Ustawienia w chmurze"):
 * the client's configuration - hotkeys above all - lives with the ACCOUNT, so
 * signing in on a new machine restores it. The local `.mlcfg` file survives only
 * as an import path from ShareX.
 *
 * The server deliberately knows NOTHING about what is inside. Hotkeys, capture
 * regions, ffmpeg presets and whatever the client grows next are the client's
 * business, and a server that validated their shape would have to be redeployed
 * every time the client added a checkbox. What the server DOES own is the two
 * things a store cannot delegate: how big the blob may get, and which write won
 * when two machines saved at once.
 *
 * Pure: no db, no next/*, no framework. The route handler, the tests and any
 * later client-config exporter all agree on the same rules without importing
 * each other.
 */

/** The only client that exists today. */
export const DESKTOP_CLIENT = "desktop";

/**
 * Which client kinds may own a row, as an ALLOWLIST rather than a free-form
 * string.
 *
 * This is a size guard, not tidiness. The table's footprint is bounded by
 * `accounts x client kinds x the byte cap below`, and that middle term only
 * stays small because the server picks it. A discriminator taken straight from
 * the query string turns one row per account into as many rows as a buggy (or
 * malicious) client cares to invent, and the cap on each one stops meaning
 * anything. Adding a second client is a code change here, which is correct: the
 * server has to know a client exists before it will store its settings.
 */
export const CLIENT_KINDS = [DESKTOP_CLIENT] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/**
 * Largest settings document we will store, measured on the canonical JSON.
 *
 * Sized against the thing being replaced: ShareX keeps its configuration in
 * three files that together come to well under 100 kB, and Modlight's own is a
 * subset with hotkeys added. 256 KiB leaves several times that much headroom
 * while keeping the whole table's worst case at `accounts x 256 KiB` - a few
 * megabytes for this deployment, and still only a couple of hundred for a server
 * with a thousand users. That bound is the point: this is the one jsonb column
 * an unsupervised background process writes to on a timer.
 */
export const CLIENT_SETTINGS_MAX_BYTES = 256 * 1024;

/**
 * Largest request body we will read, as opposed to largest document we will
 * store.
 *
 * Deliberately looser than the cap above, because the two measure different
 * things. What lands in the column is `JSON.stringify(settings)`; what arrives
 * on the wire is whatever the client's serialiser produced, which may be
 * indented, may escape non-ASCII as `\uXXXX`, and carries the envelope. A client
 * whose settings genuinely fit would otherwise be refused for pretty-printing
 * them. Twice the storage cap absorbs all of that and still refuses anything
 * that could not possibly fit once canonicalised.
 */
export const CLIENT_SETTINGS_BODY_MAX_BYTES = CLIENT_SETTINGS_MAX_BYTES * 2;

/**
 * Highest version a client may claim to hold.
 *
 * `client_settings.version` is an `int4`, and an expected version travels to
 * Postgres as a parameter typed by that column - so a value outside the range is
 * not a comparison that matches nothing, it is "value out of range for type
 * integer" raised by the driver, i.e. a 500 for a body that deserved a 400. One
 * below the int4 ceiling, because a successful write stores `expected + 1` and
 * that has to fit too.
 *
 * Unreachable in practice: a client saving every second needs about 68 years to
 * get there. It is bounded because it is user input, not because it is likely.
 */
export const MAX_EXPECTED_VERSION = 2_147_483_646;

/** `262144 bytes (256 KiB)`, so every refusal can quote the same limit. */
function limitLabel(): string {
  return `${CLIENT_SETTINGS_MAX_BYTES} bytes (${Math.round(CLIENT_SETTINGS_MAX_BYTES / 1024)} KiB)`;
}

/** Refusal for a body we stopped reading before it was parsed. */
export function bodyTooLargeMessage(): string {
  return `Request body too large. Settings are limited to ${limitLabel()} of JSON.`;
}

/**
 * Resolve the `client` discriminator a request named.
 *
 * Absent means "desktop": the only client today should not have to say so, and
 * the parameter exists for the one after it. Anything not on the allowlist is
 * `null`, which the caller turns into a refusal - never a silently created row
 * under an unknown name.
 */
export function normalizeClient(raw: string | null | undefined): ClientKind | null {
  if (raw === null || raw === undefined || raw === "") return DESKTOP_CLIENT;
  const value = raw.trim().toLowerCase();
  return (CLIENT_KINDS as readonly string[]).includes(value) ? (value as ClientKind) : null;
}

/** Refusal for an unknown client kind, listing what does exist. */
export function unknownClientMessage(): string {
  return `Unknown client. Known clients: ${CLIENT_KINDS.join(", ")}.`;
}

export type SettingsBody =
  | {
      ok: true;
      settings: Record<string, unknown>;
      /** Canonical size, i.e. what the column will actually hold. */
      bytes: number;
      /**
       * The version the client believes it is replacing, or null for "just take
       * this". See `app/api/client-settings/route.ts` for what each one does.
       */
      expectedVersion: number | null;
    }
  | { ok: false; status: 400 | 413; message: string };

/**
 * Validate a PUT body.
 *
 * Error-as-data rather than thrown strings, like the rest of the server side:
 * the caller needs the status code as much as the sentence, and this way both
 * travel together instead of one being reconstructed from the other.
 *
 * The envelope is required (`{"settings": {...}}`) rather than accepting a bare
 * object as the settings themselves. It has to carry `version` anyway, and
 * guessing between "this is the envelope" and "this is a settings document that
 * happens to have a `settings` key" is a coin flip that would eventually be
 * called wrong on somebody's real configuration.
 */
export function parseClientSettingsBody(text: string): SettingsBody {
  if (text.trim() === "") {
    return { ok: false, status: 400, message: 'Body must be JSON: {"settings": { ... }}.' };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Also the landing spot for absurdly nested input: V8 answers that with a
    // RangeError out of JSON.parse, and an uncaught one here would be a 500
    // describing our stack rather than a 400 describing their body.
    return { ok: false, status: 400, message: "Body is not valid JSON." };
  }

  if (!isPlainObject(body)) {
    return { ok: false, status: 400, message: 'Body must be a JSON object: {"settings": { ... }}.' };
  }

  const settings = (body as Record<string, unknown>).settings;
  if (!isPlainObject(settings)) {
    return { ok: false, status: 400, message: "`settings` must be a JSON object." };
  }

  const expectedVersion = readExpectedVersion((body as Record<string, unknown>).version);
  if (expectedVersion === "bad") {
    return {
      ok: false,
      status: 400,
      message: `\`version\` must be an integer between 0 and ${MAX_EXPECTED_VERSION}, or omitted.`,
    };
  }

  // Measure the canonical form, not the request: that is the string the column
  // stores, and it is what the cap is a promise about.
  const canonical = JSON.stringify(settings);
  const bytes = new TextEncoder().encode(canonical).length;
  if (bytes > CLIENT_SETTINGS_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `Settings too large: ${bytes} bytes. The limit is ${limitLabel()}.`,
    };
  }

  // Postgres `jsonb` cannot represent a NUL inside a string: it rejects the
  // escape outright, because a jsonb value has to convert to `text` and text has
  // no such character. Left unchecked this is not a stored surprise, it is a
  // raised driver error on INSERT, i.e. a 500 quoting Postgres at a client that
  // is owed a 400 quoting the reason. Checked on the canonical form because that
  // is the string the driver sends, however the client chose to spell it.
  //
  // An UNPAIRED SURROGATE is the same class of problem and is deliberately NOT
  // guarded here. Postgres's JSON lexer refuses those too ("Unicode low
  // surrogate must follow a high surrogate"), and one survives every check
  // above, because ES2019 well-formed stringify re-escapes a lone code unit
  // rather than dropping it. The obvious guard - matching `\ud[89ab]..` in the
  // canonical text - also matches a legitimate value containing those six
  // characters literally, and a canonicalised Windows path (`C:\ud800\shots`
  // becomes `C:\\ud800\\shots`) is exactly that. This column stores a Windows
  // client's capture paths, so a guard that refuses a valid save is worse than
  // the 500 it prevents on a body no real client sends. A correct version has to
  // count the backslash run, and wants a real Postgres to verify against.
  if (canonical.includes("\\u0000")) {
    return {
      ok: false,
      status: 400,
      message: "Settings must not contain NUL characters.",
    };
  }

  return { ok: true, settings: settings as Record<string, unknown>, bytes, expectedVersion };
}

/**
 * A JSON object, as opposed to an array, null, or a scalar.
 *
 * `typeof null === "object"` and arrays are objects too, so both have to be
 * ruled out by hand. Either would be accepted by the jsonb column and then come
 * back out of a GET as something the client's parser was never written for.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `number | null` for a usable value, the string "bad" for a refusal. */
function readExpectedVersion(raw: unknown): number | null | "bad" {
  // An explicit null reads as "do not check", the same as leaving the key out.
  // JSON has no other way to spell a missing number: a client whose field is
  // unset serialises it as null, and NaN/Infinity become null on the way out of
  // JSON.stringify too.
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) return "bad";
  if (raw < 0 || raw > MAX_EXPECTED_VERSION) return "bad";
  return raw;
}
