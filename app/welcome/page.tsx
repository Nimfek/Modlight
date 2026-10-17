import { getSession } from "@/lib/auth-helpers";
import { config } from "@/lib/config";
import { SiteNav } from "@/components/landing/site-nav";
import { Hero } from "@/components/landing/hero";
import { Features } from "@/components/landing/features";
import { LargeFiles } from "@/components/landing/large-files";
import { ShareX } from "@/components/landing/sharex";
import { Cta } from "@/components/landing/cta";
import { SiteFooter } from "@/components/landing/site-footer";

export default async function Home() {
  const session = await getSession();
  const isAuthed = Boolean(session);
  const appName = config.appName;
  const appUrl = config.appUrl;

  return (
    <div className="relative min-h-svh overflow-x-clip">
      {/* Subtle grid background */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-20 bg-[linear-gradient(to_right,oklch(0.5_0_0/0.05)_1px,transparent_1px),linear-gradient(to_bottom,oklch(0.5_0_0/0.05)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_75%)]"
      />

      <SiteNav appName={appName} isAuthed={isAuthed} />

      <main>
        <Hero appName={appName} isAuthed={isAuthed} />
        <Features />
        <LargeFiles />
        <ShareX appUrl={appUrl} />
        <Cta appName={appName} isAuthed={isAuthed} />
      </main>

      <SiteFooter appName={appName} />
    </div>
  );
}
