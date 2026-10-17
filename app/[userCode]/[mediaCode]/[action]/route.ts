import { Readable } from "node:stream";
import { cookies } from "next/headers";
import { and, eq, isNull } from "drizzle-orm";
import {
  cacheHeadersFor,
  codeFromMediaCode,
  consumeView,
  getMedia,
  isPrivilegedViewer,
  streamMedia,
  type MediaRow,
} from "@/lib/media/serve";
import { db } from "@/lib/db";
import { uploads, user as users, userCodeAliases } from "@/lib/db/schema";
import { getStorage } from "@/lib/storage";
import { makeThumbnail } from "@/lib/media/image";
import {
  conversionBudget,
  convertImageBuffer,
  convertOptionFor,
  probeImage,
} from "@/lib/media/convert";
import { mediaKind } from "@/lib/media/mime";
import { rowMimeType } from "@/lib/media/paste-type";
import { videoPoster } from "@/lib/media/poster";
import { motionPreview } from "@/lib/media/motion";
import {
  MOTION_DEFAULT_SIZE,
  wantsMotion,
  type MotionRefusal,
} from "@/lib/media/motion-preview";
import { timelineSheet, timelineTrack } from "@/lib/media/timeline";
import {
  TIMELINE_SHEET_ACTION,
  TIMELINE_TRACK_ACTION,
  type TimelineRefusal,
} from "@/lib/media/timeline-preview";
import { AvAbortedError, AvTimeoutError } from "@/lib/media/ffmpeg";
import { avConvert } from "@/lib/media/av-action";
import { avOptionFor } from "@/lib/media/av-targets";
import {
  contentHash,
  derivedKey,
  mayCacheDerived,
  readDerived,
  writeDerived,
} from "@/lib/media/derived-cache";
import {
  CONVERT_TIMEOUT_MS,
  CONVERT_WEIGHT,
  MAX_THUMBNAIL_PIXELS,
  MAX_TRANSFORM_BYTES,
  MOTION_TIMEOUT_MS,
  MOTION_WEIGHT,
  THUMBNAIL_TIMEOUT_MS,
  THUMBNAIL_WEIGHT,
  TIMELINE_TIMEOUT_MS,
  TIMELINE_TRACK_TIMEOUT_MS,
  TIMELINE_TRACK_WEIGHT,
  TIMELINE_WEIGHT,
} from "@/lib/media/transform-cost";
import {
  AbortedError,
  BusyError,
  imageTransforms,
  TimeoutError,
} from "@/lib/media/transform-queue";
import {
  isGenerated,
  MAX_RENDER_BYTES,
  renderAdmission,
  renderContentType,
  renderCsp,
  sandboxShape,
} from "@/lib/media/render-ticket";
import { docxToHtml, MAX_DOCX_BYTES } from "@/lib/media/docx";
import { isMediaUnlocked } from "@/lib/password";
import { isPreviewBot } from "@/lib/media/bots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Thumbnails are only rendered at these sizes. Arbitrary numbers from the query
 * string would let anyone mint unlimited distinct renders (and cache entries)
 * out of one file. 1200x630 is the Open Graph card size used by the preview page.
 */
const THUMB_SIZES = [64, 128, 256, 480, 630, 800, 1200];

/**
 * Deadline for building a document preview.
 *
 * Bounds the RESPONSE, not the work: the expensive half is JSZip expanding an
 * archive in synchronous JavaScript, which no timer can interrupt. The real
 * bound is the zip guard, which refuses an archive before mammoth ever sees it.
 */
const DOCX_TIMEOUT_MS = 20_000;

function snapThumbSize(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Round up to the next allowed step rather than rejecting, so existing links
  // keep working while the set of renders stays bounded.
  return THUMB_SIZES.find((s) => s >= n) ?? THUMB_SIZES[THUMB_SIZES.length - 1];
}

/**
 * A media player issues a Range request per seek; counting each one would burn a
 * one-time link on the first scrub. Only the opening request counts.
 */
function isInitialRequest(rangeHeader: string | null): boolean {
  return !rangeHeader || /^bytes=0-/.test(rangeHeader.trim());
}

/**
 * Is this request a preview rather than someone actually viewing the file?
 *
 * Two signals, either is enough:
 *  - a resize parameter, which only a thumbnail asks for;
 *  - `Sec-Fetch-Dest: image|video`, which the browser sets when the URL is the
 *    src of an <img>/<video> rather than a navigation.
 *
 * Without this, opening a folder gallery counts one view per tile and can burn
 * a burn-after-view link before its recipient ever clicks it.
 *
 * Only ever consulted for /raw. It is NOT a general exemption, and applying it
 * to /convert was a hole: `w` is a query parameter anyone can add, so
 * `/convert?to=pdf&w=1` downloaded a view-capped file without ever spending a
 * view - unlimited copies of a burn-after-view link, and its recipient never
 * learning it had been read. A conversion is always a deliberate download; there
 * is no thumbnail case for it to protect.
 */
/**
 * A non-negative number of seconds from the query string, or null.
 *
 * Deliberately narrow: NaN, Infinity and negatives all become "the caller did
 * not say", which is the only reading that cannot be used to smuggle a value
 * into an ffmpeg argument. The real ceilings are applied in av-cost.ts; this
 * only guarantees a finite number reaches them. Also capped well above any
 * plausible media length so `?t=1e300` cannot become a 300-character argument.
 */
function seconds(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 86_400) return null;
  return n;
}

function isPreviewFetch(req: Request, url: URL): boolean {
  // `motion` joins `w`/`h` here rather than relying on them: a moving tile is
  // asked for by a grid exactly like a still one, and a request that populated a
  // grid must not spend a view or burn a one-time link.
  if (url.searchParams.has("w") || url.searchParams.has("h")) return true;
  if (wantsMotion(url.searchParams)) return true;
  const dest = req.headers.get("sec-fetch-dest");
  return dest === "image" || dest === "video";
}

type Params = { params: Promise<{ userCode: string; mediaCode: string; action: string }> };

export async function GET(req: Request, ctx: Params): Promise<Response> {
  const { userCode, mediaCode, action } = await ctx.params;

  // Handled before anything else: the sandboxed preview is authorized by its own
  // ticket, looks the file up by id rather than by public code, and must NOT
  // spend a view (the page that issued the ticket already counted one - going
  // through the normal path would burn a one-time link the moment the toggle was
  // clicked, and would 404 outright for maxViews=1).
  if (action === "render") return renderSandboxed(req, userCode, mediaCode);

  const found = await getMedia(userCode, mediaCode);
  if (!found) return new Response("Not found", { status: 404 });
  const { media, ownerId } = found;

  // The owner (and admins) see everything and are exempt from the counters —
  // checking your own upload should not spend its view budget.
  const privileged = await isPrivilegedViewer(ownerId);

  // Unpublished media is visible only to its owner or an admin.
  if (!media.published && !privileged) return new Response("Not found", { status: 404 });

  // Same gate as the preview page, and it has to be: the page is what the
  // visitor unlocks, but /raw is what the <img> and the player actually fetch.
  // Either a token minted for this file, or the owner-scoped one covering the
  // default password this file carries (lib/password.ts).
  if (media.passwordHash && !privileged) {
    const jar = await cookies();
    const unlocked = isMediaUnlocked(
      { mediaId: media.id, ownerId, passwordVersion: media.passwordVersion },
      (name) => jar.get(name)?.value,
    );
    if (!unlocked) return new Response("Password required", { status: 401 });
  }

  const rangeHeader = req.headers.get("range");
  const reqUrl = new URL(req.url);
  // The bot check is not symmetry with the preview page for its own sake: an
  // image advertises its og:image as this very URL, so an unfurl by X or
  // WhatsApp lands here with no `w=` parameter and no Sec-Fetch-Dest, looking
  // exactly like a reader. Counting it burned a one-time link inside the chat
  // window, before the person it was sent to ever clicked.
  // ...but the exemption stops where a BUDGET starts. User-Agent is chosen by
  // the caller, so letting it waive the counter on a capped file means anyone
  // holding a one-time link can read it forever by claiming to be Discordbot,
  // and its recipient never learns the link was already spent. A capped file
  // counts every request instead, and pays nothing for it: those files no
  // longer advertise an og:image at all (lib/media/embed.ts), so no unfurler
  // fetches their bytes in the first place.
  const botExempt =
    media.maxViews == null && isPreviewBot(req.headers.get("user-agent"));

  const shouldCount =
    !privileged && isInitialRequest(rangeHeader) && !isPreviewFetch(req, reqUrl) && !botExempt;

  if (action === "download") {
    if (shouldCount && !(await consumeView(media, { download: true }))) {
      return new Response("Not found", { status: 404 });
    }
    return streamMedia(media, { rangeHeader, download: true });
  }

  // The scrub-bar preview, in two halves. Neither spends a view, for the reason
  // `isPreviewFetch` exists: both are fetched by the player while the page is
  // loading or while a pointer is moving over the bar, and counting either would
  // burn a one-time link before its recipient had watched anything.
  if (action === TIMELINE_TRACK_ACTION) return timelineTrackAction(req, media);
  if (action === TIMELINE_SHEET_ACTION) return timelineSheetAction(req, media);

  if (action === "raw" || action.startsWith("raw.")) {
    if (shouldCount && !(await consumeView(media))) {
      return new Response("Not found", { status: 404 });
    }

    const url = new URL(req.url);
    const width = snapThumbSize(url.searchParams.get("w"));
    const height = snapThumbSize(url.searchParams.get("h"));

    // mediaKind, not a `image/` prefix test: a row stored as octet-stream by a
    // client that did not know the format is still an image, and it deserves a
    // thumbnail like every other one.
    // Video joins images here. The size ceiling stays on images only: for them
    // it bounds a full read and decode, while a video poster is a seek. Videos
    // are bounded by AV_MAX_INPUT_BYTES inside videoPoster instead.
    const kind = mediaKind(media.mimeType, media.ext);
    const thumbnailable =
      kind === "video" || (kind === "image" && media.size <= MAX_TRANSFORM_BYTES);
    const fit = url.searchParams.get("fit") === "inside" ? "inside" : "cover";

    // A tile that MOVES: several frames sampled across the file, as one animated
    // WebP. Handled before the still path and never falling back to it - the
    // caller asked whether this file moves, and a still frame is a different
    // answer to a different question. A caller that does not pass `motion=1`
    // reaches exactly the code it reached before.
    if (wantsMotion(url.searchParams)) {
      return motionAction(req, media, {
        // A bare `?motion=1` still gets a bounded size rather than the file: the
        // one thing this path must never do is hand back the original.
        width: width ?? (height ? undefined : MOTION_DEFAULT_SIZE),
        height,
        fit,
      });
    }

    if ((width || height) && thumbnailable) {
      // Through the SAME limiter as /convert. This path used to run with no
      // ceiling at all, which mattered more after `mediaKind` widened the set of
      // rows that get a thumbnail: it reads the whole file, decodes it with
      // libvips, and anybody with a public link can ask for one.
      let thumb: Buffer | null = null;
      try {
        thumb = await imageTransforms.run(
          (signal) => renderThumbnail(media, { width, height, fit }, signal),
          {
            weight: THUMBNAIL_WEIGHT,
            timeoutMs: THUMBNAIL_TIMEOUT_MS,
            signal: req.signal,
          },
        );
      } catch (err) {
        const refusal = transformRefusal(err);
        // Backpressure, honestly. Falling through to the original would answer a
        // request for a 4 kB tile with a 30 MB file, which is the opposite of
        // what a loaded server should do.
        if (refusal) return refusal;
        thumb = null;
      }
      if (thumb) {
        return new Response(new Uint8Array(thumb), {
          headers: {
            "Content-Type": "image/webp",
            "X-Content-Type-Options": "nosniff",
            ...cacheHeadersFor(media),
          },
        });
      }

      // For an image, falling through hands back the original - a few hundred
      // kilobytes where a tile was wanted, which is wasteful but harmless.
      // For a VIDEO it would hand back the video: a client drawing a grid of
      // tiles would start downloading gigabytes. A tile that cannot be drawn is
      // answered as "no tile" instead, and the client falls back to its icon.
      if (kind === "video") {
        return new Response("No poster for this file", {
          status: 415,
          headers: { "Cache-Control": "no-store" },
        });
      }
      // fall through to the untransformed file
    }

    return streamMedia(media, { rangeHeader });
  }

  // On-the-fly conversion / "download as…". The set of targets depends entirely
  // on the file: lib/media/download-menu.ts is what the UI renders and what the
  // two admission tests below agree with.
  if (action === "convert") {
    return convertAction(req, media, privileged);
  }

  return new Response("Not found", { status: 404 });
}

/**
 * "Download as…" — the one endpoint on this route that spends real CPU on
 * demand for anybody holding a public link.
 */
async function convertAction(
  req: Request,
  media: MediaRow,
  privileged: boolean,
): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const to = params.get("to");

  // "Would this work?" - asked by the menu before it starts a download.
  //
  // Without it a refusal is the BODY of a download the browser has already
  // committed to: the reason header is set, nothing reads it, and the user sees
  // the word "Failed". Every gate below runs for a check; the work does not, and
  // the file's view budget is not spent.
  const check = params.get("check") === "1";

  // ffmpeg first, because an ANIMATION is claimed by both engines and they share
  // target names: `to=webp` on an AVIF sequence means "all 43 frames" to ffmpeg
  // and "the cover frame" to libvips. `avOptionFor` is the same function the
  // menu dedupes with, so the engine that answers here is the engine the entry
  // in the menu promised.
  // `media` carries the row's own width and height, and they are part of the
  // question: the web-playable target is offered only where the numbers say a
  // hardware decoder would refuse the picture. Passing the row keeps this
  // admission test identical to the menu that drew the entry.
  if (avOptionFor(media.mimeType, media.ext, media.frames, to, media)) {
    try {
      const handled = await avConvert({
        media,
        privileged,
        to,
        offsetSeconds: seconds(params.get("t")),
        clipSeconds: seconds(params.get("d")),
        signal: req.signal,
        dryRun: check,
        // No `isPreviewFetch` exemption, for the reason on that function: a
        // conversion is always a deliberate download.
        admit: privileged ? undefined : () => consumeView(media, { download: true }),
      });
      if (handled) return handled;
    } catch (err) {
      return transformRefusal(err) ?? new Response("Conversion failed", { status: 500 });
    }
  }

  // The admission test IS the menu. `convertOptionFor` is what FileMenu and
  // MediaActions render from, so a target visible in the UI can always be
  // delivered and one that is not visible cannot be asked for. Checking only
  // "is this a known format name" let `?to=avif` through on files whose menu
  // never offered it, and let the menu offer five targets for an SVG that this
  // handler then refused.
  const option = convertOptionFor(media.mimeType, media.ext, media.frames, to);
  if (!option) {
    return imageRefusal(415, "wrong-target");
  }
  if (media.size > MAX_TRANSFORM_BYTES) {
    return imageRefusal(413, "too-large", { limit: String(MAX_TRANSFORM_BYTES) });
  }

  // A check that the ROW can answer, with no read and no decode.
  //
  // The image engine's expensive step is pulling the whole source into memory,
  // and a check that did that would double the I/O of every download it
  // precedes. It does not have to: the only thing left that can refuse a known,
  // in-budget image is `unreadable`, and a row carrying dimensions is itself
  // evidence that libvips opened this file once already. Round 8 backfilled
  // dimensions for 8052 of the imported uploads, so this answers for nearly
  // everything; anything still missing a fact falls through to the full path.
  if (check && media.width && media.height && media.frames != null) {
    const framePixels = media.width * media.height;
    const budget = conversionBudget(
      {
        animated: media.frames > 1,
        framePixels,
        totalPixels: framePixels * media.frames,
      },
      option.to,
    );
    return budget.ok ? convertOk() : imageRefusal(413, "too-many-pixels");
  }

  // No `isPreviewFetch` exemption here: see the note on that function. A
  // conversion is a download, and a view-capped file pays for it. Skipped for a
  // check, which must not be able to burn a one-time link.
  if (!check && !privileged && !(await consumeView(media, { download: true }))) {
    return new Response("Not found", { status: 404 });
  }

  const variant = `${option.to}${option.motion === "keeps" ? "-anim" : ""}`;
  const cacheable = mayCacheDerived(media);
  const base = media.filename.replace(/\.[^.]+$/, "") || media.code;

  // A hash we already have means a cache hit costs nothing at all - no read of
  // the source, no decode. Rows written before checksums were recorded have
  // none, so theirs is computed (and stored) the first time somebody converts them.
  if (cacheable && media.checksum) {
    const key = derivedKey(media.id, media.checksum, variant, extFor(option.to));
    const hit = await readDerived(key);
    // The output already exists, so nothing about this conversion can refuse.
    if (hit) return check ? convertOk() : convertedResponse(hit, option.to, base);
  }

  try {
    return await imageTransforms.run(
      async (signal) => {
        const src = await getStorage().readBuffer(media.storageKey);
        const hash = media.checksum ?? contentHash(src);

        if (cacheable && !media.checksum) {
          const hit = await readDerived(derivedKey(media.id, hash, variant, extFor(option.to)));
          if (hit) {
            remember(media, { checksum: hash });
            // Mirrors the checksum-known cache hit above. Without this, a row
            // whose checksum never got written but whose conversion IS cached
            // answers `?check=1` with the entire converted file - a "would this
            // work?" question answered by sending the megabytes, on every click.
            return check ? convertOk() : convertedResponse(hit, option.to, base);
          }
        }

        // Ask sharp whether it can open this at all BEFORE committing to the
        // work. Some formats we correctly recognise as images are still beyond
        // libvips (an AVIF image sequence is the one that started this), and the
        // honest answer to that is 415, not the 500 a thrown encoder produced.
        const probe = await probeImage(src);
        if (!probe) {
          return imageRefusal(415, "unreadable");
        }

        // We have just learned two things about this row that only opening the
        // file can tell us. Writing them back is what heals the 8.6k imported
        // uploads that carry neither: the next conversion skips the read
        // entirely, and the menu stops guessing about animation from the
        // container. Fire and forget - a failed write costs a repeat, nothing more.
        // `frames` records what the FILE holds, not what libvips can reach. For
        // a cover-only read (an AVIF sequence, where libheif hands us the
        // primary item and hides the other 42) the honest answer is "still
        // unknown", so nothing is written. Recording 1 there used to be a lie
        // with a consequence: av-targets.ts withholds the animated GIF/WebP
        // offer from anything known to hold a single frame, so stamping 1 would
        // have hidden the one conversion that reaches those frames.
        remember(media, {
          checksum: hash,
          frames: probe.coverOnly ? undefined : probe.pages,
        });

        // Counts every frame when the animation is being kept, and measures the
        // ceiling against the TARGET: 64 Mpx of PNG is 384 MB, 64 Mpx of AVIF
        // would be 2.6 GB in a 2 GiB container.
        const budget = conversionBudget(probe, option.to);
        if (!budget.ok) {
          return imageRefusal(413, "too-many-pixels");
        }

        // Every gate has spoken and only the encode is left, so this is where a
        // check stops. The read and the probe above were not wasted: both wrote
        // what they learned back to the row, so the download that follows this
        // check skips them.
        if (check) return convertOk();

        const { buffer, mime, ext } = await convertImageBuffer(probe.input, option.to, {
          animated: budget.animated,
          timeoutMs: CONVERT_TIMEOUT_MS,
          signal,
        });

        if (cacheable) {
          await writeDerived(derivedKey(media.id, hash, variant, ext), buffer);
        }
        return convertedResponse(buffer, option.to, base, { mime, ext });
      },
      { weight: CONVERT_WEIGHT, timeoutMs: CONVERT_TIMEOUT_MS, signal: req.signal },
    );
  } catch (err) {
    return transformRefusal(err) ?? new Response("Conversion failed", { status: 500 });
  }
}

/**
 * Record a fact we only learn by opening the file, and only where the row has
 * none. Never awaited: nothing on this path should wait on a write, and a row
 * that stays unfilled simply gets asked again next time.
 */
function remember(media: MediaRow, facts: { checksum?: string; frames?: number }): void {
  const patch: { checksum?: string; frames?: number } = {};
  if (facts.checksum && !media.checksum) patch.checksum = facts.checksum;
  if (facts.frames && media.frames == null) patch.frames = facts.frames;
  if (Object.keys(patch).length === 0) return;
  void db
    .update(uploads)
    .set(patch)
    .where(eq(uploads.id, media.id))
    .catch(() => {});
}

/** MIME + extension a target produces, without running it. */
const TARGET_OUTPUT: Record<string, { mime: string; ext: string }> = {
  pdf: { mime: "application/pdf", ext: "pdf" },
  png: { mime: "image/png", ext: "png" },
  jpg: { mime: "image/jpeg", ext: "jpg" },
  webp: { mime: "image/webp", ext: "webp" },
  avif: { mime: "image/avif", ext: "avif" },
};

function extFor(to: string): string {
  return TARGET_OUTPUT[to]?.ext ?? to;
}

function convertedResponse(
  buffer: Buffer,
  to: string,
  base: string,
  known?: { mime: string; ext: string },
): Response {
  const out = known ?? TARGET_OUTPUT[to];
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": out.mime,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.${out.ext}`)}`,
      "X-Content-Type-Options": "nosniff",
      // The derived bytes are cached on OUR disk, keyed by content; the response
      // still must not enter a shared cache, because the file behind it can be
      // unpublished or deleted at any moment.
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Turn a limiter refusal into a response, or null when the error is a real
 * failure the caller should report as 500.
 */
/**
 * A refusal from the IMAGE engine, in the same vocabulary the audio/video engine
 * uses (`refusal` in lib/media/av-action.ts).
 *
 * These four used to be bare prose with no header at all, so even a UI that
 * wanted to explain the failure had nothing to read. The token is what
 * messages/{en,pl}/files.json translates; the body stays English prose for
 * anything reading the endpoint directly.
 */
function imageRefusal(
  status: number,
  reason: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(IMAGE_REASON_TEXT[reason] ?? reason, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Convert-Refused": reason,
      ...extra,
      "Cache-Control": "no-store",
    },
  });
}

const IMAGE_REASON_TEXT: Record<string, string> = {
  "wrong-target": "This file cannot be converted to that format",
  "too-large": "File too large to convert",
  unreadable: "This format cannot be converted",
  "too-many-pixels": "Image too large to convert to this format",
};

/** "Yes, this would work." The answer to `?check=1`; carries no bytes. */
function convertOk(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

function transformRefusal(err: unknown): Response | null {
  // ffprobe's own timeout and its "the caller went away" now reach here instead
  // of being swallowed into a `null` that the conversion path would remember as
  // "this file is unreadable" for ten minutes. They mean the same things as the
  // queue's own two errors, so they get the same two answers.
  if (err instanceof AvTimeoutError) {
    return new Response("Reading the file took too long", {
      status: 503,
      headers: {
        "Retry-After": "10",
        "X-Convert-Refused": "timeout",
        "Cache-Control": "no-store",
      },
    });
  }
  if (err instanceof AvAbortedError) {
    return new Response(null, { status: 499, headers: { "Cache-Control": "no-store" } });
  }
  if (err instanceof BusyError) {
    return new Response("Too many transforms in progress", {
      status: 503,
      headers: {
        "Retry-After": "5",
        "X-Convert-Refused": "busy",
        "Cache-Control": "no-store",
      },
    });
  }
  if (err instanceof TimeoutError) {
    return new Response("Transform took too long", {
      status: 503,
      headers: {
        "Retry-After": "30",
        "X-Convert-Refused": "timeout",
        "Cache-Control": "no-store",
      },
    });
  }
  if (err instanceof AbortedError) {
    // Nobody is listening; the status only has to be cheap and non-cacheable.
    return new Response(null, { status: 499, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}

/**
 * Serve an uploaded HTML/SVG document for real, in isolation.
 *
 * Everything here is a gate, in cheapest-first order:
 *  1. only a frame load (Sec-Fetch-Dest), so the URL can never become a
 *     top-level phishing page on our domain;
 *  2. a valid, unexpired ticket minted by the preview page, which is issued only
 *     after published/password/expiry/views have been cleared;
 *  3. every one of those conditions re-checked here anyway, against the row the
 *     ticket names, because a ticket outlives a change of mind;
 *  4. the MIME allowlist and the size ceiling;
 *  5. a response CSP that puts the document in an opaque origin.
 */
async function renderSandboxed(
  req: Request,
  userCode: string,
  mediaCode: string,
): Promise<Response> {
  const url = new URL(req.url);

  // The Content-Security-Policy that sandboxes this response is set by
  // next.config, and Next matches those rules against the RAW path while the App
  // Router hands this handler the DECODED segment. `/{tag}/{code}/%72ender`
  // therefore arrives here as action === "render" but carries the ordinary
  // app-wide policy, with no sandbox directive at all - uploaded HTML served as
  // text/html in our real origin. A handler cannot repair that from the inside,
  // because Next applies the config headers before running this code and only
  // fills in keys the response has not already set (send-response.js), so the
  // policy built below is dropped whenever the config rule already matched.
  //
  // Refusing anything not spelled literally keeps the two in step: either the
  // config rule matched and the sandbox is on, or we never serve the bytes.
  if (!url.pathname.endsWith("/render")) return notRenderable();

  const admission = renderAdmission({
    secFetchDest: req.headers.get("sec-fetch-dest"),
    ticket: url.searchParams.get("t"),
  });

  if (!admission.allow) {
    // A human who followed the link gets the preview page, where the toggle is.
    // Only for a request that positively identified itself as a top-level load:
    // redirecting a frame would render the whole preview page inside it and
    // spend another view on each click (see `unknown-dest` in render-ticket.ts).
    if (admission.reason === "not-a-frame") {
      // Both segments come from the (decoded) path, so they are re-encoded here:
      // a header value must not be able to carry a line break out of a URL.
      const back = `/${encodeURIComponent(userCode)}/${encodeURIComponent(mediaCode)}`;
      return new Response(null, {
        status: 302,
        headers: { Location: back, "Cache-Control": "no-store" },
      });
    }
    return new Response("Preview link is invalid or expired", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const rows = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, admission.mediaId), isNull(uploads.deletedAt)))
    .limit(1);
  const media = rows[0];
  if (!media) return notRenderable();

  // The ticket names the file; the URL must agree, so a link can never display
  // one file under another one's address.
  if (media.code !== codeFromMediaCode(mediaCode)) return notRenderable();

  // ...and the tag must belong to the owner, current or retired. Matching the
  // code alone would let any file render under anybody's tag, which is a promise
  // the preview page keeps (lib/media/serve.ts resolves the tag through
  // user_code_aliases) and this route would otherwise quietly break. An orphaned
  // upload has no tag at all, so it renders nowhere - same as its preview page.
  if (!(await tagBelongsToOwner(userCode, media.ownerId))) return notRenderable();

  const privileged = media.ownerId ? await isPrivilegedViewer(media.ownerId) : false;
  if (!media.published && !privileged) return notRenderable();
  if (media.expiresAt && media.expiresAt.getTime() <= Date.now()) return notRenderable();

  // Strictly greater, not >=: the preview page that issued this ticket already
  // spent one view, so on the last permitted view the counter has ALREADY
  // reached the cap by the time the toggle can be clicked. Comparing with >=
  // here made the toggle dead for every maxViews=1 file - precisely the case
  // skipping consumeView was meant to protect. The ticket is bound to one file
  // and lives 15 minutes, so honouring the view the page paid for opens nothing.
  if (media.maxViews != null && media.views > media.maxViews) return notRenderable();

  // Password: the ticket is not a substitute for the unlock cookie. The frame is
  // loaded same-origin by our page, so the cookie is sent with it.
  if (media.passwordHash && !privileged) {
    const jar = await cookies();
    const unlocked = isMediaUnlocked(
      { mediaId: media.id, ownerId: media.ownerId, passwordVersion: media.passwordVersion },
      (name) => jar.get(name)?.value,
    );
    if (!unlocked) return new Response("Password required", { status: 401 });
  }

  // `rowMimeType`, because this handler looks the row up by id rather than
  // through `getMedia` and so does not get the resolution that path applies. A
  // paste declares its type through its language; without this the toggle the
  // preview page offers for an HTML paste would lead to a 404.
  const shape = sandboxShape(rowMimeType(media), media.ext);
  if (!shape) return notRenderable();
  const sizeLimit = shape === "docx" ? MAX_DOCX_BYTES : MAX_RENDER_BYTES;
  if (media.size > sizeLimit) {
    return new Response("Too large to preview", { status: 413 });
  }

  // A document is CONVERTED rather than served: mammoth turns the .docx into
  // HTML, which then travels through exactly the same sandbox as an uploaded
  // page. See lib/media/docx.ts for why that beats sanitising the output.
  let body: Readable | string;
  if (isGenerated(shape)) {
    const rendered = await renderDocument(media);
    if ("status" in rendered) return rendered.response;
    body = rendered.html;
  } else {
    try {
      body = await getStorage().readStream(media.storageKey);
    } catch {
      // Row without bytes behind it: a 404 is the honest answer, not a 500.
      return notRenderable();
    }
  }

  return new Response(
    typeof body === "string" ? body : (Readable.toWeb(body) as unknown as ReadableStream),
    {
    status: 200,
    headers: {
      "Content-Type": renderContentType(shape),
      "Content-Security-Policy": renderCsp(shape),
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
        // The response differs by how it was requested and by who is asking.
        Vary: "Sec-Fetch-Dest, Cookie",
      },
    },
  );
}

/**
 * Convert a .docx to HTML for the sandbox.
 *
 * Through the shared limiter, at thumbnail weight: it unzips an archive and
 * re-encodes every embedded picture through libvips, which is the same class of
 * work as a thumbnail and must not be exempt from the one gate all of it goes
 * through. The refusals carry a token the UI can translate, matching the
 * convention the conversion endpoint uses.
 */
async function renderDocument(
  media: MediaRow,
): Promise<{ html: string } | { status: number; response: Response }> {
  let result;
  try {
    result = await imageTransforms.run(
      async () => docxToHtml(await getStorage().readBuffer(media.storageKey)),
      {
        weight: THUMBNAIL_WEIGHT,
        timeoutMs: DOCX_TIMEOUT_MS,
      },
    );
  } catch (err) {
    const refusal = transformRefusal(err);
    return {
      status: 503,
      response: refusal ?? new Response("Preview failed", { status: 500 }),
    };
  }

  if (!result.ok) {
    return {
      status: 415,
      response: new Response(`Cannot preview this document (${result.reason})`, {
        status: result.reason === "too-large" || result.reason === "too-big" ? 413 : 415,
        headers: { "X-Preview-Refused": result.reason, "Cache-Control": "no-store" },
      }),
    };
  }

  return { html: result.html };
}

function notRenderable(): Response {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * Does `tag` address `ownerId` - as their current tag, or one they retired?
 *
 * Mirrors the check in lib/media/serve.ts. An upload with no owner (its account
 * was deleted with "keep the files") is addressed by nobody's tag, so it is not
 * reachable here either.
 */
async function tagBelongsToOwner(tag: string, ownerId: string | null): Promise<boolean> {
  if (!ownerId) return false;

  const owner = await db
    .select({ userCode: users.userCode })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (!owner[0]) return false;
  if (owner[0].userCode === tag) return true;

  const alias = await db
    .select({ userId: userCodeAliases.userId })
    .from(userCodeAliases)
    .where(eq(userCodeAliases.code, tag))
    .limit(1);

  return !!alias[0] && alias[0].userId === ownerId;
}

/**
 * Best-effort thumbnail; null means "serve the original instead".
 *
 * Runs inside the shared limiter, so `signal` is the deadline the limiter
 * granted, not the raw request signal.
 */
/**
 * `/{tag}/{code}/raw?w=…&motion=1` - a thumbnail that moves.
 *
 * Through the SAME limiter as the still thumbnail and /convert, at a thumbnail's
 * weight: the memory profile is a thumbnail's (one source frame materialised at
 * a time), and this URL is reachable by anyone holding a public link.
 *
 * The one rule that matters here is what happens when there is no preview to
 * make. It is never the original file - a client drawing a grid of tiles that
 * fell through would start downloading gigabytes, which is the failure the video
 * poster's 415 already exists to prevent - and it is never a still either, because
 * a client that asked whether this file moves would then have no way of knowing
 * it does not.
 */
async function motionAction(
  req: Request,
  media: MediaRow,
  opts: { width?: number; height?: number; fit: "cover" | "inside" },
): Promise<Response> {
  let result: Awaited<ReturnType<typeof motionPreview>>;
  try {
    result = await imageTransforms.run((signal) => motionPreview(media, opts, signal), {
      weight: MOTION_WEIGHT,
      timeoutMs: MOTION_TIMEOUT_MS,
      signal: req.signal,
    });
  } catch (err) {
    // Backpressure and cancellation share their answers with every other
    // transform: 503 with a Retry-After, or 499 for a caller that has gone.
    return transformRefusal(err) ?? motionRefusal("unreadable");
  }

  if (!result.ok) return motionRefusal(result.refusal);

  return new Response(new Uint8Array(result.buffer), {
    headers: {
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      // Counted out of the bytes we are about to send, not out of what sharp was
      // asked for, so a client can tell a moving tile from a still one without
      // decoding it.
      "X-Motion-Frames": String(result.frames),
      ...cacheHeadersFor(media),
    },
  });
}

/**
 * "There is no moving tile for this file, and here is why."
 *
 * Deliberately NOT in the `X-Convert-Refused` vocabulary that
 * tests/unit/convert-vocabulary.test.ts guards. That vocabulary exists because
 * the download menu turns a refusal into a translated sentence in front of a
 * person; these tokens are read by a client deciding whether to draw a still
 * icon instead, and inventing user-facing copy for a decision no user sees would
 * be words nobody reads and translators have to maintain.
 *
 * `no-store` on every one of them: a row gains and loses the ability to produce
 * a preview (a file converted in place, a frame count backfilled), and a cached
 * refusal would outlive the reason for it.
 */
function motionRefusal(reason: MotionRefusal): Response {
  return new Response(MOTION_REFUSAL_TEXT[reason], {
    status: reason === "too-large" ? 413 : 415,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Motion-Refused": reason,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * The metadata track: which rectangle of the sheet belongs to which moment.
 *
 * Through the SAME limiter as everything else that touches an uploaded file, at
 * a THUMBNAIL's weight and with a short deadline, because this half is a probe
 * and some string building. It is requested on every view of a video page, while
 * the sheet below is only built once somebody actually reaches for the bar, so
 * the cheap half must never queue behind the expensive one.
 */
async function timelineTrackAction(req: Request, media: MediaRow): Promise<Response> {
  let result: Awaited<ReturnType<typeof timelineTrack>>;
  try {
    result = await imageTransforms.run((signal) => timelineTrack(media, signal), {
      weight: TIMELINE_TRACK_WEIGHT,
      timeoutMs: TIMELINE_TRACK_TIMEOUT_MS,
      signal: req.signal,
    });
  } catch (err) {
    // Backpressure and cancellation share their answers with every other
    // transform: 503 with a Retry-After, or 499 for a caller that has gone. That
    // includes a probe that was killed, which reaches here as AvTimeoutError
    // rather than being swallowed into "this file has no preview".
    return transformRefusal(err) ?? timelineRefusal("unreadable");
  }

  if (!result.ok) return timelineRefusal(result.refusal);

  return new Response(result.vtt, {
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...derivedCacheHeaders(media),
    },
  });
}

/**
 * The sprite sheet the track's cues address.
 *
 * A conversion's weight and a conversion's deadline: the worst job measured on
 * production is 4.0 s of ffmpeg and 260 MB on a two core box. Never falls
 * through to the file - a player that asked for a tooltip and was handed the
 * video would download gigabytes, which is the failure the video poster's 415
 * already exists to prevent.
 */
async function timelineSheetAction(req: Request, media: MediaRow): Promise<Response> {
  let result: Awaited<ReturnType<typeof timelineSheet>>;
  try {
    result = await imageTransforms.run((signal) => timelineSheet(media, signal), {
      weight: TIMELINE_WEIGHT,
      timeoutMs: TIMELINE_TIMEOUT_MS,
      signal: req.signal,
    });
  } catch (err) {
    return transformRefusal(err) ?? timelineRefusal("unreadable");
  }

  if (!result.ok) return timelineRefusal(result.refusal);

  return new Response(new Uint8Array(result.buffer), {
    headers: {
      "Content-Type": "image/jpeg",
      "X-Content-Type-Options": "nosniff",
      ...derivedCacheHeaders(media),
    },
  });
}

/**
 * Cache headers for an artefact whose SHAPE is decided by our code, not only by
 * the bytes it was made from.
 *
 * `cacheHeadersFor` grants a year and `immutable` to a published, ungated file,
 * which is right for the file itself and for a thumbnail, because each of those
 * answers for itself. These two do not: a VTT written by one version of the
 * planner and a sheet written by another produce a preview whose rectangles are
 * off by a tile, and a year is long enough for a browser to be holding one of
 * each. A day, revalidated, means a change to the tile geometry propagates by
 * itself instead of waiting out a promise we should not have made.
 *
 * The restricted case is untouched: a gated file still gets `private, no-store`
 * from the same function, because a derived copy of a gated file is a copy that
 * outlives the gate.
 */
function derivedCacheHeaders(media: MediaRow): Record<string, string> {
  const headers = cacheHeadersFor(media);
  if (headers["Cache-Control"]?.startsWith("public")) {
    headers["Cache-Control"] = "public, max-age=86400, must-revalidate";
  }
  return headers;
}

/**
 * "There is no timeline for this file, and here is why."
 *
 * Same shape and same reasoning as `motionRefusal`: a token a client reads to
 * decide whether to hang a `<track>` on its player, deliberately outside the
 * `X-Convert-Refused` vocabulary that gets translated for people, and `no-store`
 * on every one of them because a row gains and loses the ability to produce a
 * preview (a file converted in place, an engine installed).
 */
function timelineRefusal(reason: TimelineRefusal): Response {
  return new Response(TIMELINE_REFUSAL_TEXT[reason], {
    status: reason === "too-large" ? 413 : 415,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Timeline-Refused": reason,
      "Cache-Control": "no-store",
    },
  });
}

/** Exhaustive by type, so a new refusal cannot ship without prose for it. */
const TIMELINE_REFUSAL_TEXT: Record<TimelineRefusal, string> = {
  "not-video": "This file has no timeline to preview",
  "too-large": "File too large for a timeline preview",
  "too-short": "This file is too short for a timeline preview",
  "too-many-pixels": "Frames too large to preview",
  "unknown-duration": "This file does not say how long it is",
  unreadable: "This file cannot be previewed",
  "no-engine": "Timeline previews are not available on this server",
};

/** Exhaustive by type, so a new refusal cannot ship without prose for it. */
const MOTION_REFUSAL_TEXT: Record<MotionRefusal, string> = {
  "not-animated": "This file does not move",
  "too-large": "File too large for a motion preview",
  "too-many-pixels": "Too many frames to preview",
  "unknown-duration": "This file does not say how long it is",
  unreadable: "This file cannot be previewed",
  "no-engine": "Motion previews are not available on this server",
};

async function renderThumbnail(
  media: MediaRow,
  opts: { width?: number; height?: number; fit: "cover" | "inside" },
  signal: AbortSignal,
): Promise<Buffer | null> {
  try {
    // A video has no still to resize, so one is taken first. Cheap because
    // ffmpeg seeks to the frame instead of decoding up to it, and cached after
    // the first request - see lib/media/poster.ts.
    //
    // The size guard below deliberately does not apply here: videos are large by
    // nature, and MAX_TRANSFORM_BYTES is a ceiling on how much we are willing to
    // READ AND DECODE. A seek reads neither.
    if (mediaKind(media.mimeType, media.ext) === "video") {
      const frame = await videoPoster(media, signal);
      if (!frame) return null;
      return await makeThumbnail(frame, { ...opts, timeoutMs: THUMBNAIL_TIMEOUT_MS });
    }

    const buf = await getStorage().readBuffer(media.storageKey);
    if (signal.aborted) return null;

    // probeImage rather than a bare metadata() call: it also carries the `avis`
    // brand workaround, so the one production AVIF sequence gets a thumbnail
    // instead of silently falling through to a 4 MB original on every tile.
    // The declared size is still the guard - a 40 kB PNG can claim 100k x 100k.
    const probe = await probeImage(buf);
    if (!probe || probe.framePixels <= 0 || probe.framePixels > MAX_THUMBNAIL_PIXELS) {
      return null;
    }

    // The file has just been opened, so its frame count is free here - and a row
    // that does not carry one can never be offered a moving tile, because
    // `canMotionPreview` refuses to advertise what it is not sure of. On
    // production that is nearly the whole imported library: 8098 of 8197 image
    // rows have `frames` NULL, all 32 GIFs among them, and the Round 8 backfill
    // cannot reach them (it fills width/height and selects `WHERE width IS
    // NULL`, so those rows are already past it). Drawing a grid once now teaches
    // the library about itself.
    //
    // `coverOnly` is excluded for the reason /convert excludes it: when libvips
    // hands back only the primary item of an AVIF sequence, 1 is what libvips
    // could reach and not what the file holds, and recording it would be a lie
    // with consequences elsewhere.
    if (!probe.coverOnly) remember(media, { frames: probe.pages });

    return await makeThumbnail(probe.input, { ...opts, timeoutMs: THUMBNAIL_TIMEOUT_MS });
  } catch {
    return null;
  }
}
