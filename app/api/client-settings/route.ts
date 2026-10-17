import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clientSettings } from "@/lib/db/schema";
import { resolveApiCaller } from "@/lib/api-caller";
import {
  bodyTooLargeMessage,
  CLIENT_SETTINGS_BODY_MAX_BYTES,
  CLIENT_SETTINGS_MAX_BYTES,
  normalizeClient,
  parseClientSettingsBody,
  unknownClientMessage,
  type ClientKind,
} from "@/lib/client-settings";

/**
 * The desktop client's configuration, stored against the account.
 *
 * GET hands back what is stored (or an empty default), PUT replaces it whole.
 * The server never looks inside: what a hotkey or a capture preset means is the
 * client's business, and the client does not exist yet. See lib/client-settings.ts
 * for the two things the server DOES decide — the size cap, and what happens
 * when two machines save at once.
 *
 * Authenticates with an API TOKEN first and a session second, in that order.
 * The token is what a desktop app has; the session is a convenience so the same
 * URL can be opened in a logged-in browser while debugging. Either way the
 * answer is scoped to one account.
 */

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // A per-account answer must never be held by a shared cache.
      "cache-control": "private, no-store",
    },
  });
}

/** Columns every response is built from. */
const RETURNED = {
  version: clientSettings.version,
  settings: clientSettings.settings,
  updatedAt: clientSettings.updatedAt,
};

type StoredRow = { version: number; settings: Record<string, unknown>; updatedAt: Date };

/**
 * The wire shape, identical for GET, PUT and the 409 body.
 *
 * `limitBytes` is included so a client can refuse an over-sized save locally
 * instead of discovering the cap by being rejected, and so raising it later does
 * not need a client release.
 */
function shape(client: ClientKind, row: StoredRow | undefined) {
  return {
    client,
    // 0 is "nothing stored yet", which is what a client PUTs back as its
    // expected version on a fresh machine. A stored row starts at 1.
    version: row?.version ?? 0,
    settings: row?.settings ?? {},
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    limitBytes: CLIENT_SETTINGS_MAX_BYTES,
  };
}

function current(ownerId: string, client: ClientKind) {
  return db
    .select(RETURNED)
    .from(clientSettings)
    .where(and(eq(clientSettings.ownerId, ownerId), eq(clientSettings.client, client)))
    .limit(1);
}

export async function GET(req: Request): Promise<Response> {
  // Reading the blob back onto another machine.
  const auth = await resolveApiCaller(req, "read");
  if (!auth.ok) return json(auth.body, auth.status);
  const caller = auth.caller;

  const client = normalizeClient(new URL(req.url).searchParams.get("client"));
  if (!client) return json({ message: unknownClientMessage() }, 400);

  const [row] = await current(caller.id, client);
  return json(shape(client, row));
}

export async function PUT(req: Request): Promise<Response> {
  // Replacing it. The blob carries the client's hotkeys and capture presets, so
  // an upload-only credential has no business rewriting how a machine behaves.
  const auth = await resolveApiCaller(req, "write");
  if (!auth.ok) return json(auth.body, auth.status);
  const caller = auth.caller;

  const client = normalizeClient(new URL(req.url).searchParams.get("client"));
  if (!client) return json({ message: unknownClientMessage() }, 400);

  const body = await readCappedBody(req, CLIENT_SETTINGS_BODY_MAX_BYTES);
  if (!body.ok) return json({ message: bodyTooLargeMessage() }, 413);

  const parsed = parseClientSettingsBody(body.text);
  if (!parsed.ok) return json({ message: parsed.message }, parsed.status);

  const now = new Date();
  const values = {
    ownerId: caller.id,
    client,
    settings: parsed.settings,
    version: 1,
    updatedAt: now,
  };

  // No expected version: "take this, whatever was there". The blind path, and
  // the one a client that has never synced should use.
  if (parsed.expectedVersion === null) {
    const [row] = await db
      .insert(clientSettings)
      .values(values)
      .onConflictDoUpdate({
        target: [clientSettings.ownerId, clientSettings.client],
        set: {
          settings: parsed.settings,
          // In DO UPDATE, the qualified column is the row already there — so
          // this is "one more than whatever the loser of the race left", not
          // "one more than what I read a moment ago".
          version: sql`${clientSettings.version} + 1`,
          updatedAt: now,
        },
      })
      .returning(RETURNED);
    return json(shape(client, row));
  }

  // An expected version of 0 asserts "nothing is stored". Only an insert that
  // actually inserts satisfies it; a row appearing in between is a conflict, not
  // something to overwrite.
  if (parsed.expectedVersion === 0) {
    const [row] = await db
      .insert(clientSettings)
      .values(values)
      .onConflictDoNothing({ target: [clientSettings.ownerId, clientSettings.client] })
      .returning(RETURNED);
    return row ? json(shape(client, row)) : conflict(caller.id, client);
  }

  // The compare-and-set that makes concurrent machines safe. Ownership lives in
  // the same WHERE as the version rather than in a SELECT first: one statement
  // cannot be raced between its check and its write, and a row belonging to
  // somebody else is simply not matched.
  //
  // The new version is `expected + 1` rather than an increment expression
  // because the WHERE already pinned the old value, so the two are the same
  // number and this one is legible.
  const [row] = await db
    .update(clientSettings)
    .set({ settings: parsed.settings, version: parsed.expectedVersion + 1, updatedAt: now })
    .where(
      and(
        eq(clientSettings.ownerId, caller.id),
        eq(clientSettings.client, client),
        eq(clientSettings.version, parsed.expectedVersion),
      ),
    )
    .returning(RETURNED);

  return row ? json(shape(client, row)) : conflict(caller.id, client);
}

/**
 * Somebody else wrote first.
 *
 * The current state travels WITH the 409 so the client can merge and retry from
 * one round trip. A bare 409 would force a follow-up GET, and a client that
 * skipped it would be tempted to just PUT again without a version — which is
 * precisely the silent clobber the version exists to prevent.
 */
async function conflict(ownerId: string, client: ClientKind): Promise<Response> {
  const [row] = await current(ownerId, client);
  return json(
    {
      message: "Settings were changed elsewhere. Merge and retry with the returned version.",
      ...shape(client, row),
    },
    409,
  );
}

type CappedBody = { ok: true; text: string } | { ok: false };

/**
 * Read the body, refusing anything over `limit` INSTEAD OF buffering it first.
 *
 * `req.text()` would read a two-gigabyte body into memory and hand it over so we
 * could measure it and throw it away — on a shared host, from an endpoint whose
 * whole job is to be written to by an unattended background process. The
 * declared length is checked first because refusing before reading costs
 * nothing, and the running total is checked because a chunked body declares no
 * length at all.
 *
 * Cancelling the reader is what tells the sender to stop, rather than politely
 * draining a body already decided against.
 */
async function readCappedBody(req: Request, limit: number): Promise<CappedBody> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return { ok: false };

  if (!req.body) return { ok: true, text: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }

  // Decoded in one pass over the joined buffer, so a multi-byte character split
  // across two chunks is still one character.
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}
