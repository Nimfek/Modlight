"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  APP_NAME,
  currentRelease,
  publishRelease,
  unpublishRelease,
  type ReleaseManifest,
} from "@/lib/releases";

/**
 * Publishing the desktop app's release, from the panel.
 *
 * Until now the only way to point the channel at a build was
 * `POST /api/releases/app` with an admin token. That is fine for a script and
 * wrong for a person: it means anybody cutting a release has to mint, carry and
 * paste a credential to do something they are already signed in to do. The
 * upload itself is a normal upload - the release is one settings row naming its
 * code - so all this needs is a form.
 *
 * Everything here re-checks admin on the server. A Server Action is a public
 * endpoint with a nicer calling convention; the button being hidden proves
 * nothing.
 */

export interface ReleaseState {
  manifest: ReleaseManifest | null;
  appName: string;
}

export async function loadRelease(): Promise<ReleaseState> {
  await requireAdmin();
  return { manifest: await currentRelease(), appName: APP_NAME };
}

export type PublishOutcome =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; reason: "no-version" | "bad-version" | "not-found" | "not-public" }
  | { ok: false; reason: "version-mismatch"; fileVersion: string; filename: string };

/**
 * Point the channel at an upload.
 *
 * `code` is the short code out of the file's own link, which is what an admin
 * has in front of them after uploading the installer - not an internal id they
 * would have to go looking for.
 */
export async function publishAppRelease(input: {
  version: string;
  code: string;
  notes?: string;
  /** Second click on "publish anyway" after the file name disagreed. */
  allowVersionMismatch?: boolean;
}): Promise<PublishOutcome> {
  await requireAdmin();

  // Accept a whole link as well as a bare code. Somebody who has just uploaded
  // the installer has the URL on their clipboard, and making them edit it down
  // by hand is the kind of small rudeness that gets a step skipped later.
  const code = lastPathSegment(input.code);

  const result = await publishRelease({
    version: input.version,
    code,
    notes: input.notes,
    allowVersionMismatch: input.allowVersionMismatch === true,
  });
  if (result.ok) {
    revalidatePath("/dashboard/admin");
    revalidatePath("/dashboard/tokens");
    revalidatePath("/download");
  }
  return result;
}

export async function unpublishAppRelease(): Promise<{ ok: true }> {
  await requireAdmin();
  await unpublishRelease();
  revalidatePath("/dashboard/admin");
  revalidatePath("/dashboard/tokens");
  revalidatePath("/download");
  return { ok: true };
}

/**
 * The code out of whatever was pasted: a bare code, a full link, or a link with
 * an extension. The extension is decorative in this app's URLs (it is trimmed at
 * the dot), so it is trimmed here too rather than being sent on to fail a lookup.
 */
function lastPathSegment(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withoutQuery = trimmed.split(/[?#]/)[0];
  const segment = withoutQuery.split("/").filter(Boolean).pop() ?? "";
  const dot = segment.indexOf(".");
  return dot > 0 ? segment.slice(0, dot) : segment;
}
