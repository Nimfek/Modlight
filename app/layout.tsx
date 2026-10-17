import type { Metadata } from "next";
// Self-hosted Geist (bundled woff2 via next/font/local) — no Google Fonts fetch
// at build time, so Docker/offline builds always work.
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { getSession } from "@/lib/auth-helpers";
import { config } from "@/lib/config";
import { MODE_COOKIE, SKIN_COOKIE, resolveMode } from "@/lib/theme-cookies";
import { resolveTheme } from "@/lib/themes";

export const metadata: Metadata = {
  title: { default: config.appName, template: `%s - ${config.appName}` },
  description: "Fast, modern, self-hosted file & screenshot sharing with rock-solid large-file uploads and first-class ShareX support.",
  applicationName: config.appName,
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [locale, messages, jar, session] = await Promise.all([
    getLocale(),
    getMessages(),
    cookies(),
    // Degrades to the cookie rather than taking every page down with it: if the
    // session lookup fails, a page that needs no database should still render.
    getSession().catch(() => null),
  ]);

  // Both theme axes are rendered onto <html> here, server-side, so the first
  // painted frame is already correct - no class-swapping after hydration.
  //   data-mode  … the viewer's colour mode ("system" lets CSS follow the OS)
  //   data-theme … the viewer's own skin; public pages override it with the
  //                owner's skin via <ThemeApplier>, which runs before paint.
  const mode = resolveMode(jar.get(MODE_COOKIE)?.value);

  // The stored column beats the cookie for anyone signed in, and that order is
  // the whole reason a skin set from the desktop client shows up here.
  //
  // `ml_skin` is written by the browser that made the change - the profile
  // Server Action and <ThemeApplier> both set it - so it is a fast first-paint
  // hint, not a store. A write that arrives over the API has no browser and no
  // cookie to set, which left the cookie holding the PREVIOUS skin: the panel
  // eventually corrected itself because <ThemeApplier> repaints it from the
  // session, but every page outside the panel (the landing page, /welcome, the
  // download page, the auth screens) has no applier and would have kept showing
  // the stale skin indefinitely - and even inside the panel the first frame was
  // painted wrong before the applier's inline script ran.
  //
  // Reading the session costs nothing for the anonymous traffic that dominates
  // public links: with no session cookie present Better Auth answers null
  // without touching the database.
  const skin = resolveTheme(session?.user.theme ?? jar.get(SKIN_COOKIE)?.value);

  return (
    <html
      lang={locale}
      data-mode={mode}
      data-theme={skin}
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <body className="bg-background text-foreground min-h-full">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider
            attribute="data-mode"
            // Seeded from the cookie so a cleared localStorage still lands on
            // the mode the server just rendered.
            defaultTheme={mode}
            enableSystem
            disableTransitionOnChange
          >
            <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
            <Toaster richColors position="bottom-right" />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
