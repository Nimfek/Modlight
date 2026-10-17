import { currentRelease } from "@/lib/releases";

/**
 * The stable address of the current Modlight Downloader build.
 *
 * A redirect rather than a proxy, on purpose: the target is an ordinary upload,
 * so following it gets Range requests, resumable downloads, the ETag and the
 * storage driver's own streaming for free. Re-serving the bytes through here
 * would reimplement all four, worse.
 *
 * Its whole value is that it does not change. `/{tag}/{code}` names one build
 * forever, which is right for a file and wrong for "the latest version" — a
 * link put in a README or an installer would freeze on the day it was written.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const release = await currentRelease();
  if (!release) {
    return new Response("No release published yet.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: release.url,
      // Short, and never `immutable`: this URL means "whatever is current", so
      // a cached redirect is precisely how somebody keeps downloading a build
      // that was replaced weeks ago.
      "cache-control": "public, max-age=60",
      // Handy for a script that wants to know what it is about to fetch without
      // reading the manifest first.
      "x-release-version": release.version,
      ...(release.sha256 ? { "x-release-sha256": release.sha256 } : {}),
    },
  });
}
