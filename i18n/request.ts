import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

export const LOCALES = ["en", "pl"] as const;
export type Locale = (typeof LOCALES)[number];

// One file per UI area under messages/<locale>/. Each feature owns its own
// namespace file so translations never collide.
const NAMESPACES = [
  "common", "nav", "auth", "dashboard", "profile",
  "paste", "links", "albums", "tokens", "admin",
  "public", "landing", "viewer", "files", "upload",
  "download", "authorize",
] as const;

/**
 * Locale resolution (no URL routing):
 *   1) explicit cookie `ml_locale` (set when a user picks a language)
 *   2) Accept-Language — Polish browsers get 'pl', everyone else 'en'
 *      (only pl/en supported; e.g. German falls back to English).
 */
export default getRequestConfig(async () => {
  const c = await cookies();
  const cookieLoc = c.get("ml_locale")?.value;
  let locale: Locale = cookieLoc === "pl" || cookieLoc === "en" ? cookieLoc : "en";

  if (!cookieLoc) {
    const al = (await headers()).get("accept-language") ?? "";
    locale = /(?:^|[,\s])pl\b/i.test(al) ? "pl" : "en";
  }

  const messages: Record<string, unknown> = {};
  await Promise.all(
    NAMESPACES.map(async (n) => {
      messages[n] = (await import(`../messages/${locale}/${n}.json`)).default;
    }),
  );

  return { locale, messages };
});
