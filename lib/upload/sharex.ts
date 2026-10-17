import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { config } from "@/lib/config";
import { hasRoomFor } from "@/lib/upload/disk";
import { authenticateApiToken, tokenRefusal, type TokenAuth, type UserRow } from "@/lib/api-token";
import { FOLDER_KEY, resolveFolderTarget } from "@/lib/upload/folder-target";
import { firstMatchFor } from "@/lib/upload/duplicate-lookup";
import { mediaUrls } from "@/lib/media/urls";
import { finalizeUpload, QuotaExceededError, OutOfSpaceError, CodeTakenError } from "@/lib/upload/finalize";

const VERSION = "0.1.0";

/**
 * Ceiling for a request that did NOT authenticate through a header.
 *
 * A legacy `.sxcu` passes the token as a multipart *field*, and
 * ShareX may emit it after the file part — so those bytes would already be on
 * disk before we know who sent them. Without a ceiling any anonymous POST could
 * fill the server's disk. Requests carrying `x-api-key` (the config we generate
 * today) are exempt and stay unlimited, which is the whole point of the product.
 */
export const ANON_MAX_BYTES = anonLimitFromEnv();

function anonLimitFromEnv(): number {
  const raw = Number(process.env.LEGACY_UPLOAD_MAX_SIZE);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 512 * 1024 * 1024;
}

/** How much of the payload's header is kept for content sniffing. */
const HEAD_BYTES = 4096;

/** Raised by the byte meter when an unauthenticated body outgrows the cap. */
class AnonLimitError extends Error {}
/** Raised when the client (or the socket) goes away mid-body. */
class ClientGoneError extends Error {}

const noop = () => {};

function send(res: ServerResponse, status: number, body: Record<string, unknown>) {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ version: VERSION, ...body }));
}

/**
 * The exact wording for "no such token", kept because ShareX users'
 * configs and third-party scripts have been matching on it since v1.
 */
const UNKNOWN_TOKEN = "Token specified not found.";

/**
 * Answer a token refusal with the shared status and body.
 *
 * 404 for an unknown token, because that is what ShareX configs have always
 * received and what ShareX's error dialog has always shown. A token that EXISTS and is not allowed
 * to upload is a different fact and keeps the 403 the shared mapping produces —
 * a bare 404 there would send somebody regenerating a config that was never the
 * problem.
 */
function refuse(res: ServerResponse, auth: Extract<TokenAuth, { ok: false }>): void {
  const { status, body } = tokenRefusal(auth, UNKNOWN_TOKEN);
  return send(res, auth.reason === "unknown" ? 404 : status, body);
}

/** Pull an API token out of `x-api-key` or an `Authorization: Bearer` header. */
export function bearerFromHeaders(req: { headers: IncomingHttpHeaders }): string | undefined {
  const xApi = req.headers["x-api-key"];
  if (typeof xApi === "string" && xApi) return xApi;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim() || undefined;
  }
  return undefined;
}

/**
 * ShareX / legacy single-POST upload endpoint (POST /upload).
 *
 * Streams the file straight to a temp file (constant memory, no body cap),
 * hashing as it goes. Auth is resolved from the `x-api-key`/`Authorization`
 * header BEFORE a single byte is read; the legacy multipart `token` field still
 * works but is capped at ANON_MAX_BYTES because it can arrive too late to gate
 * on. Response shape is the one existing ShareX configs expect.
 *
 * SCOPE: `upload`, at all three places a token can enter, and nothing wider.
 * Posting a file is the only thing that happens here, so the credential a
 * ShareX config carries never needs to be able to list, change or delete a
 * library — and that credential is the one most likely to leak, since it sits
 * in plain text in a settings folder that syncs between machines and appears
 * whole in a screenshot of the destinations window.
 */
export async function handleShareXUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // ── auth before any disk IO ──
  // Both auth paths (header here, legacy `token` field below) go through
  // authenticateApiToken, which stamps api_tokens.last_used_at in the same
  // statement that resolves the token — that is what feeds "last used" on the
  // profile, and it lands even when the scope check then refuses, because a
  // token being turned away repeatedly is exactly what you want to be able to
  // see.
  const headerToken = bearerFromHeaders(req);
  let owner: UserRow | null = null;
  if (headerToken) {
    const auth = await authenticateApiToken(headerToken, "upload");
    if (!auth.ok) return refuse(res, auth);
    owner = auth.user;
  }

  // ── refuse an oversized body BEFORE a byte touches the disk ──
  //
  // The headroom check in finalizeUpload runs after the transfer, which is far
  // too late to be a defence: a body larger than the free space fills the disk
  // on its way to being rejected, and a full disk takes down every other
  // application on this host. Content-Length is a claim, not a guarantee, but a
  // client that lies about it still gets stopped later by the same guard, and an
  // honest oversized upload now fails in a millisecond instead of an hour.
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > 0) {
    if (!(await hasRoomFor(declared, config.uploads.tmpPath))) {
      return send(res, 507, { message: "Server is low on disk space; upload rejected." });
    }
  }

  let bb: Busboy.Busboy;
  try {
    bb = Busboy({
      headers: req.headers,
      // Multipart field and filename values are UTF-8 in practice, but busboy
      // defaults to latin1 — which silently turns "Chłopak.mp4" into
      // "ChÅopak.mp4" and stores that as the file's name forever. RFC 7578
      // says UTF-8, and every client that matters sends it.
      defParamCharset: "utf8",
      limits: {
        files: 1,
        fileSize: config.uploads.maxSize > 0 ? config.uploads.maxSize : undefined,
      },
    });
  } catch {
    return send(res, 400, { message: "Invalid multipart request." });
  }

  await mkdir(config.uploads.tmpPath, { recursive: true });
  const tmpPath = join(config.uploads.tmpPath, randomUUID());

  const fields: Record<string, string> = {};
  let filename: string | null = null;
  let mime = "application/octet-stream";
  let size = 0;
  let gotFile = false;
  // First bytes of the payload, kept so finalizeUpload can tell what the file
  // really is without reading it back. They stream through us anyway, so this
  // costs one small allocation and no extra I/O.
  const headChunks: Buffer[] = [];
  let headBytes = 0;
  let overHardLimit = false;
  let overAnonLimit = false;
  let pendingAuth: Promise<TokenAuth> | null = null;
  let fileWrite: Promise<void> = Promise.resolve();
  const hash = createHash("sha256");
  // Fires when the client disappears: tears the temp-file writer down so its fd
  // is released (and its promise settles) before we unlink the scratch file.
  const teardown = new AbortController();

  try {
    bb.on("field", (name, val) => {
      fields[name] = val;
      // Legacy config: the token rides along as a form field. When it happens to
      // arrive before the file we can authenticate mid-stream and lift the
      // anonymous cap instead of rejecting a perfectly legitimate large upload.
      if (name === "token" && !owner && !pendingAuth) {
        pendingAuth = authenticateApiToken(val, "upload").then((auth) => {
          // Only an ALLOWED token lifts the anonymous cap. A real token that is
          // scoped away from uploading must not buy the body an unlimited
          // budget on its way to being refused.
          if (auth.ok) owner = auth.user;
          return auth;
        });
      }
    });

    bb.on("file", (_name, stream, info) => {
      if (gotFile) {
        stream.resume(); // busboy's files:1 limit already skips these; drain anyway
        return;
      }
      gotFile = true;
      filename = info.filename || "file";
      mime = info.mimeType || mime;

      const meter = new Transform({
        async transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          if (headBytes < HEAD_BYTES) {
            const take = chunk.subarray(0, HEAD_BYTES - headBytes);
            headChunks.push(Buffer.from(take));
            headBytes += take.length;
          }
          size += chunk.length;
          if (!owner && size > ANON_MAX_BYTES) {
            // A token field may still be in flight — give it a chance to land
            // before refusing.
            if (pendingAuth) await pendingAuth;
            if (!owner) {
              overAnonLimit = true;
              cb(new AnonLimitError());
              return;
            }
          }
          cb(null, chunk);
        },
      });

      stream.on("limit", () => {
        overHardLimit = true;
      });

      fileWrite = pipeline(stream, meter, createWriteStream(tmpPath), { signal: teardown.signal });
      // Tear busboy down on a write failure so pumpBody() settles instead of
      // waiting for a 'close' that will never come.
      fileWrite.catch(() => bb.destroy());
    });

    await pumpBody(req, res, bb, teardown);
    await fileWrite;

    // ── validate ──
    if (overHardLimit) return send(res, 413, { message: "File too large." });
    if (!gotFile) return send(res, 400, { message: "Request without file attached." });

    if (!owner) {
      const bodyToken = fields.token;
      if (!bodyToken) return send(res, 400, { message: "Token not specified." });
      // The field may have arrived after the file, in which case the mid-stream
      // check above never ran — verify it now.
      const auth = await (pendingAuth ?? authenticateApiToken(bodyToken, "upload"));
      if (!auth.ok) return refuse(res, auth);
      owner = auth.user;
    }

    // ── where should it land? ──
    //
    // Resolved here rather than at finalize so the row is written into the right
    // folder first time. An id this account does not own does NOT fail the
    // upload: by now the bytes are on our disk, and discarding a finished 4 GB
    // transfer because a folder was deleted in the panel an hour ago is a worse
    // outcome than filing it under the account default. The client is told,
    // which is what lets an app refresh its picker instead of silently putting
    // every future download somewhere the user did not choose.
    let folderId: string | null | undefined;
    let folderWarning: string | undefined;
    try {
      folderId = await resolveFolderTarget(owner.id, fields[FOLDER_KEY]);
    } catch {
      folderId = undefined;
      folderWarning = "unknown-folder";
    }

    // ── had we already got these exact bytes? ──
    //
    // The hash is a by-product of streaming the payload past us, so asking costs
    // one indexed lookup (`uploads_owner_checksum_idx`) and nothing else.
    //
    // It is a REPORT, never a refusal, and it deliberately runs after the whole
    // transfer rather than being turned into an early exit. A single-POST client
    // has already spent its uplink by the time the last byte - and therefore the
    // checksum - exists, so there is nothing left to save; and refusing here
    // would break the ShareX contract, which promises a 201 with a URL. What it
    // buys is a client that can say "you already had this, here it is" and offer
    // to drop the copy. The panel gets the version that actually prevents the
    // transfer, at POST /api/uploads/check, which ShareX cannot speak.
    //
    // Asked BEFORE the insert on purpose: afterwards the new row is itself a
    // match and would have to be excluded by id, which is a correctness detail
    // nobody should have to maintain. A failure here is swallowed - an advisory
    // field is never worth failing a completed upload over.
    const checksum = hash.digest("hex");
    const existing = await firstMatchFor(owner.id, checksum).catch((err) => {
      console.error("[sharex] duplicate lookup failed:", err);
      return null;
    });

    // ── finalize ──
    try {
      const result = await finalizeUpload({
        owner,
        filename: filename ?? "file",
        mime,
        size,
        localPath: tmpPath,
        head: Buffer.concat(headChunks),
        checksum,
        customCode: fields.code || undefined,
        folderId,
      });
      const duplicate = existing ? mediaUrls(owner, existing.code, existing.ext) : null;
      return send(res, 201, {
        message: "OK",
        url: result.url,
        raw_url: result.rawUrl,
        // The link to put on the clipboard, chosen by the ACCOUNT's `copy_raw`
        // preference. A client that copies this follows the panel switch for
        // free instead of shipping its own competing setting.
        copy_url: result.copyUrl,
        deletionUrl: result.deletionUrl,
        folder: result.folderId,
        ...(folderWarning ? { folder_warning: folderWarning } : {}),
        // Absent unless there really is an older copy: an always-present null
        // reads as "we checked and there is none", which is not something this
        // endpoint can promise for a library full of checksumless rows.
        ...(existing && duplicate
          ? {
              duplicate_of: {
                code: existing.code,
                filename: existing.filename,
                size: Number(existing.size),
                created_at: existing.createdAt.toISOString(),
                folder: existing.folderId,
                url: duplicate.url,
                raw_url: duplicate.rawUrl,
                copy_url: owner.copyRaw ? duplicate.rawUrl : duplicate.url,
              },
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof QuotaExceededError) return send(res, 507, { message: err.message });
      // 507 as well: from the client's side "there is no room for this" is the
      // same outcome, whether the ceiling is the account's or the machine's.
      if (err instanceof OutOfSpaceError) return send(res, 507, { message: err.message });
      if (err instanceof CodeTakenError) return send(res, 409, { message: err.message });
      console.error("[sharex] finalize failed:", err);
      return send(res, 500, { message: "Upload failed." });
    }
  } catch (err) {
    // Every body-stage failure lands here, whichever stream noticed it first:
    // busboy reports "unexpected end of form" for the same truncation that the
    // meter reports as a limit breach, so the flags decide the status code.
    if (overAnonLimit) {
      return send(res, 413, {
        message:
          "File too large for an unauthenticated upload. Send your token in the x-api-key header (regenerate your ShareX config) to upload files of any size.",
      });
    }
    if (overHardLimit) return send(res, 413, { message: "File too large." });
    if (err instanceof ClientGoneError) return; // nothing left to reply to
    console.error("[sharex] upload stream failed:", err);
    return send(res, 400, { message: "Upload stream failed." });
  } finally {
    // Wait for the writer to release its fd before unlinking (Windows refuses to
    // delete an open file), then reclaim the scratch file. finalizeUpload MOVES
    // it on the happy path, so this is usually a no-op — on every other path it
    // is what stops data/tmp from growing without bound.
    teardown.abort();
    await fileWrite.catch(noop);
    await rm(tmpPath, { force: true }).catch(noop);
  }
}

/**
 * Pipe the request body into busboy and settle exactly once.
 *
 * busboy is a plain Writable: when the client vanishes mid-upload nothing tells
 * it to stop, so awaiting `bb.on('close')` alone leaves this handler — and its
 * socket, and its temp file — pending forever. That was the "upload hangs after
 * the connection drops" bug. We therefore watch the request AND the response for
 * a disconnect and tear the parser down ourselves.
 */
function pumpBody(
  req: IncomingMessage,
  res: ServerResponse,
  bb: Busboy.Busboy,
  teardown: AbortController,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Node throws on an 'error' event that has no listener. These permanent
    // no-ops guarantee that an error arriving *after* we settled (destroying
    // busboy emits one, for instance) can never take the whole process down.
    bb.on("error", noop);
    req.on("error", noop);

    let settled = false;

    const cleanup = () => {
      req.off("aborted", onAbort);
      req.off("close", onReqClose);
      req.off("error", onReqError);
      res.off("close", onResClose);
      bb.off("close", onClose);
      bb.off("error", onBusboyError);
    };
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };

    const onClose = () => settle();
    const onBusboyError = (err: Error) => {
      teardown.abort();
      bb.destroy();
      settle(err);
    };
    const onAbort = () => {
      teardown.abort();
      bb.destroy();
      settle(new ClientGoneError("Client aborted the upload."));
    };
    const onReqError = (err: Error) => {
      teardown.abort();
      bb.destroy();
      settle(err);
    };
    // 'close' fires on both a clean end and an abort; readableEnded tells them
    // apart ('aborted' is deprecated but still emitted, hence both listeners).
    const onReqClose = () => {
      if (!req.readableEnded) onAbort();
    };
    const onResClose = () => {
      if (!res.writableFinished) onAbort();
    };

    bb.once("close", onClose);
    bb.once("error", onBusboyError);
    req.once("aborted", onAbort);
    req.once("close", onReqClose);
    req.once("error", onReqError);
    res.once("close", onResClose);

    req.pipe(bb);
  });
}
