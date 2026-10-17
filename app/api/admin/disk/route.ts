import {
  authenticateApiToken,
  bearerFromRequest,
  scopeRefusalBody,
  type UserRow,
} from "@/lib/api-token";
import { getSession } from "@/lib/auth-helpers";
import { UNAUTHORIZED_BODY } from "@/lib/api-caller";
import { checkRateLimit } from "@/lib/password";
import { serverStorageUsage } from "@/lib/data/admin";
import { diskInsights, TRASH_DUE_SOON_DAYS } from "@/lib/data/admin-disk";
import { TRASH_RETENTION_DAYS } from "@/lib/maintenance/trash";

/**
 * The server disk report, for an administrator's desktop client.
 *
 * The panel has had this screen since Round 11 (`/dashboard/admin`, rendered by
 * components/admin/ServerDisk.tsx). Everything it knows lives in Server
 * Actions and server components, which a C# client cannot invoke - so the
 * desktop app's "Serwer" tab had nothing to call and showed "this server is not
 * answering yet" forever. This is that screen's data, and nothing more: it
 * calls the SAME two read models the page calls, so the two cannot drift into
 * disagreeing about how full the machine is.
 *
 * `lib/data/admin.ts` used to say serverStorageUsage() was deliberately not
 * exposed over HTTP. That was written when the only credential was an
 * all-or-nothing API token, where "exposed over HTTP" meant "exposed to every
 * token any account had ever minted". Scoped tokens (Round 14) changed the
 * fact the sentence rested on, and the comment there has been updated to match
 * rather than left to contradict this file.
 *
 * Read-only, so there is nothing to audit and no CSRF surface: GET is the only
 * verb.
 */

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store", ...headers },
  });
}

/**
 * What an authenticated caller who is not an administrator is told.
 *
 * 404, not 403. A 403 answers "is this account an administrator on this server"
 * with a yes-or-no the account was never entitled to ask, and an account that
 * learns it is one step away from a server-wide report is an account that now
 * knows what to phish for. 404 answers nothing: it is the same status a build
 * without this route returns.
 *
 * Same reasoning, same status, as `ownedFolder` in lib/folders.ts, where "not
 * yours", "does not exist" and "not even a uuid" deliberately collapse into one
 * answer.
 *
 * And it is the same RESPONSE, not merely the same status: `text/plain`, the
 * body `Not found`, no cache-control - byte for byte what Next answers for a
 * path with no route at all (verified against the deployment). A JSON body
 * saying the same thing would have leaked by its shape what the status was
 * careful not to say, because only a handwritten 404 has one.
 *
 * The cost is that this refusal carries no `private, no-store`, which every
 * other answer here does. Deliberate, and small: the header is itself a
 * tell, nothing in front of this app caches (nginx proxies without a cache),
 * and a "not found" that somehow was cached is the same answer the caller would
 * have got anyway.
 */
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain;charset=UTF-8" },
  });
}

/**
 * A missing or unusable CREDENTIAL is 401, not 404, and that is not a
 * contradiction of the rule above.
 *
 * Every route on this surface answers 401 to a request carrying no credential,
 * so the status says nothing about this route in particular. It says a great
 * deal to the client, though: it is the only thing that separates "your token
 * was revoked" from "this server is too old to have the endpoint", and a
 * desktop client that cannot tell those apart tells its user the wrong one.
 */
type Gate = { ok: true; id: string } | { ok: false; response: Response };

function isAdminRow(user: Pick<UserRow, "role">): boolean {
  return user.role === "admin";
}

/**
 * Two gates, and they are two because they answer two different questions.
 *
 * The ROLE is a fact about the account: only an administrator may read what
 * every other account is storing. The SCOPE is a fact about the credential: a
 * token an administrator pasted into a screenshot uploader is a token that
 * lives in a config file on a laptop, and the blast radius of that file leaking
 * must not include the whole install's file listing. So an administrator's
 * `write` token - the ordinary one in their own desktop app - does not open
 * this, exactly as it does not publish a release
 * (app/api/releases/app/route.ts, same precedent, same order of checks).
 *
 * Order matters as much as the pair. The credential is resolved first because
 * there is no role to check until it is; but a scope refusal is only ever
 * SPOKEN OUT LOUD to an administrator, because "this token is too narrow for
 * this endpoint" is itself a statement that the endpoint exists and that this
 * account could reach it with a wider one. To everybody else the narrow token
 * is a 404, like everything else here.
 */
async function gate(req: Request): Promise<Gate> {
  const token = bearerFromRequest(req.headers);

  if (token) {
    const auth = await authenticateApiToken(token, "admin");

    if (auth.ok) {
      if (!isAdminRow(auth.user)) return { ok: false, response: notFound() };
      return { ok: true, id: auth.user.id };
    }

    switch (auth.reason) {
      case "banned":
        // A disabled account is told it is disabled, on every surface, whatever
        // it was reaching for. Saying 404 here would send an administrator whose
        // account was just switched off looking for a server upgrade.
        return { ok: false, response: json({ message: "Account disabled." }, 401) };
      case "scope":
        return isAdminRow(auth.user)
          ? { ok: false, response: json({ ...scopeRefusalBody(auth) }, 403) }
          : { ok: false, response: notFound() };
      case "invalid-scope":
        // A real token whose stored scope this build does not recognise. There
        // is no user on this branch of the union, so administrator-ness cannot
        // be established - and a check that cannot be made fails closed.
        return { ok: false, response: notFound() };
      default:
        return { ok: false, response: json({ ...UNAUTHORIZED_BODY }, 401) };
    }
  }

  // No token offered: the cookie may speak. A session is the account itself and
  // carries no scope to narrow (see lib/api-caller.ts), so the role is the only
  // gate left. This is the path the panel's own fetch would take.
  const session = await getSession();
  if (!session) return { ok: false, response: json({ ...UNAUTHORIZED_BODY }, 401) };
  if (session.user.role !== "admin") return { ok: false, response: notFound() };
  return { ok: true, id: session.user.id };
}

/**
 * Calls per account per minute.
 *
 * The report is the most expensive read in the app - six sequential scans of
 * `uploads` plus a statfs - and until now the only way to ask for it was to
 * open a page in a browser, which paces itself. A client with a refresh timer
 * does not, and a client with a BUGGY refresh timer really does not. Thirty a
 * minute is far more than a human clicking refresh and far less than a loop.
 *
 * Keyed on the account rather than the IP: the credential is what is being
 * paced, and an administrator behind the same NAT as their own users should not
 * pay for their traffic.
 */
const CALLS_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;

export async function GET(req: Request): Promise<Response> {
  const caller = await gate(req);
  if (!caller.ok) return caller.response;

  const limit = checkRateLimit(`admin-disk:${caller.id}`, CALLS_PER_MINUTE, RATE_WINDOW_MS);
  if (!limit.allowed) {
    return json({ message: "Too many requests.", reason: "rate_limited" }, 429, {
      "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)),
    });
  }

  // The same two calls, in the same order, as app/(app)/dashboard/admin/page.tsx
  // and components/admin/ServerDisk.tsx. In parallel because they are what the
  // page already runs in parallel; each holds one pooled connection for the
  // milliseconds it takes over a table of this size, and the cost argument for
  // every statement is written above each query in lib/data/admin-disk.ts.
  const [usage, insights] = await Promise.all([serverStorageUsage(), diskInsights()]);

  /**
   * The two read models, flattened into one object, field for field.
   *
   * The shape is not invented here: `ModlightDiskReport` in the desktop client
   * (ShareX/Modlight/ModlightServerDisk.cs) was written against it, and its own
   * comment says why it mirrors the read models rather than reading "more like
   * C#" - so that anyone comparing the two screens does not have to hold a
   * translation table in their head. Nothing is renamed, regrouped or
   * recomputed on the way out. Every value below is `usage.x` or `insights.x`.
   *
   * WHAT IS MEASURED AND WHAT IS ONLY COUNTED, which is the one thing this
   * report must not blur:
   *
   *  - `disk` is a real statfs of the filesystem the uploads sit on. It is the
   *    only measurement here, it includes everything else on that filesystem,
   *    and it is NULL on an object store, where there is no server disk to fill
   *    and no way to learn what the bucket holds short of listing it.
   *  - everything else is the DATABASE's answer: the sum of `uploads.size` as
   *    recorded when each file arrived. Even on local storage that is a FLOOR,
   *    not a total - thumbnails, cached conversions and the leftovers of an
   *    interrupted upload are real bytes on the same storage with no row to
   *    their name.
   *
   * `driver` and `local` are what a client reads to know which of those two
   * sentences it is allowed to print, exactly as components/admin/ServerDisk.tsx
   * picks between its filesystem card and its database-only card. Sending a
   * bucket estimate in `disk` to make the shape uniform would be presenting a
   * count as a measurement, which is the single mistake this report exists to
   * avoid.
   *
   * No `url` on the file rows, though `ownerTag`, `code` and `ext` are all
   * there for a client that wants to build one: a field the client ignores is a
   * field the next person trusts by mistake.
   */
  return json({
    driver: usage.driver,
    local: insights.local,

    liveFiles: usage.liveFiles,
    liveBytes: usage.liveBytes,
    trashedFiles: usage.trashedFiles,
    trashedBytes: usage.trashedBytes,

    disk: usage.disk,
    minFreeBytes: usage.minFreeBytes,

    /** Live bytes by what each file actually is (Round 7's `effectiveType`). */
    kinds: insights.kinds,
    kindBytes: insights.kindBytes,

    /**
     * Per account, heaviest first, trash included. `rest: true` is the folded
     * tail rather than a dropped one, so the column still adds up to the total
     * above it; `orphaned: true` is the pseudo-row for files whose owner was
     * deleted and whose bytes now belong to nobody.
     */
    accounts: insights.accounts,

    /**
     * `lastAccessedAt: null` is NOT evidence that nobody ever opened the file.
     * Access has only been counted since a row was written on this server, and
     * rows that predate the counter, or were imported, carry no history at
     * all. The panel prints that caveat under
     * its own list (`admin.disk.coldNote`) and the client's DTO repeats it in
     * the remarks on `LastAccessedAt`; it is stated here so a third reader of
     * this route does not have to rediscover it.
     */
    biggest: insights.biggest,
    cold: insights.cold,
    coldTotals: insights.coldTotals,

    trash: insights.trash,
    // Both windows travel, rather than being compiled into the client: they are
    // this deployment's policy, and a client that hard-coded 30 would caption
    // the trash wrongly the day an operator changed it.
    trashRetentionDays: TRASH_RETENTION_DAYS,
    trashDueSoonDays: TRASH_DUE_SOON_DAYS,
  });
}
