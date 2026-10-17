import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";
import { config } from "@/lib/config";
import { registrationPageState } from "@/lib/registration";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("login.title") };
}

/** Sanitize ?next= to an in-app path so it can't be used as an open redirect. */
function safeNext(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/dashboard";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const target = safeNext(next);
  const [t, registration] = await Promise.all([
    getTranslations("auth"),
    // Same source of truth as /register, so the "Create one" link is never an
    // invitation to a page that refuses to render a form.
    registrationPageState(),
  ]);

  return (
    <AuthCard
      title={t("login.title")}
      description={t("login.description", { appName: config.appName })}
    >
      <LoginForm next={target} registrationEnabled={registration.open} />
    </AuthCard>
  );
}
