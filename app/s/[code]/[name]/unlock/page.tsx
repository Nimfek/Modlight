import ShortlinkUnlockPage, { generateMetadata as unlockMetadata } from "../../unlock/page";
import { scopedShortCode } from "@/lib/naming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const generateMetadata = unlockMetadata;

/**
 * Password gate for a namespaced short link: /s/{userCode}/{code}/unlock.
 *
 * The stored code already contains the tag ("alicja/test"), so this just
 * re-joins the two segments and hands them to the existing gate — which then
 * navigates back to /s/{userCode}/{code} once the unlock cookie is set. Keeping
 * one implementation means the rate limiting, cookie handling and the owner's
 * skin cannot drift between the two link shapes.
 */
export default async function NamespacedShortlinkUnlockPage({
  params,
}: {
  params: Promise<{ code: string; name: string }>;
}) {
  const { code: tag, name } = await params;
  return ShortlinkUnlockPage({ params: Promise.resolve({ code: scopedShortCode(tag, name) }) });
}
